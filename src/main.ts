import {
	InstanceBase,
	InstanceStatus,
	type CompanionOptionValues,
	type SomeCompanionConfigField,
	type DropdownChoice,
	type CompanionInputFieldDropdown,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions, buildDeviceSlugs, slugifyMac, type VariablesSchema } from './variables.js'
import { UpgradeScripts, MIGRATED_PORT_OPTION } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import {
	getApplicationInfo,
	listSites,
	listDevices,
	partitionValidDevices,
	listClients,
	getDevice,
	restartDevice as restartDeviceRequest,
	powerCyclePort as powerCyclePortRequest,
	type UnifiDevice,
	type UnifiDeviceDetail,
	type UnifiClientConfig,
	type UnifiResult,
	type UnifiSite,
} from './unifi-client.js'
import { UnifiLegacyClient } from './unifi-legacy-client.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const MAC_PATTERN = /^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/i

function normalizeMac(value: string): string {
	return value.toLowerCase().replace(/[^0-9a-f]/g, '')
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets // Setup in init()

	devices: UnifiDevice[] = []
	deviceDetails: Map<string, UnifiDeviceDetail> = new Map()
	/** Every client seen during this session (key: lower case MAC address), used for stable online/offline variables. */
	knownClients: Map<string, { name: string; ipAddress?: string; macAddress: string }> = new Map()
	private connectedClientMacs: Set<string> = new Set()
	/** Number of currently connected clients per uplink device (key: device ID), e.g. clients per access point. */
	private clientCountByUplink: Map<string, number> = new Map()
	private deviceSlugs: Map<string, string> = new Map()
	/** Devices from the last device list that had no usable ID and were skipped (see partitionValidDevices). */
	private skippedDevices: string[] = []
	applicationVersion = ''
	lastActionResult = ''
	/** Resolved site UUID (the Integration API only accepts UUIDs, no "default" alias like the old API). */
	private resolvedSiteId = ''
	/** Sites found on the last successful connection, used to offer the site as a dropdown in the config UI. */
	knownSites: UnifiSite[] = []

	private pollTimer: ReturnType<typeof setTimeout> | undefined
	/**
	 * Incremented on every config change and on destroy. Refresh/poll work started under an older generation
	 * stops at its next step and never writes its (stale) results.
	 */
	private generation = 0
	private destroyed = false
	/** Refreshes and polls run strictly one after another through this chain. */
	private refreshQueue: Promise<void> = Promise.resolve()
	private legacyClient: UnifiLegacyClient | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		this.setVariableValues({
			connection_status: 'unknown',
			application_version: '',
			site_id: config.siteId,
			device_count: 0,
			device_count_online: 0,
			last_poll_time: '',
			last_action_result: '',
		})

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()

		await this.refreshDevices()
		this.schedulePoll()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.generation++
		this.stopPolling()
		await this.resetLegacyClient()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.generation++
		this.stopPolling()

		const connectionChanged =
			config.host !== this.config.host ||
			config.port !== this.config.port ||
			config.siteId !== this.config.siteId ||
			secrets.apiKey !== this.secrets.apiKey
		this.config = config
		this.secrets = secrets
		await this.resetLegacyClient()

		// Data of another console/site must not stay visible in dropdowns, presets, feedbacks or variables.
		if (connectionChanged) this.clearSiteData()

		// Config dependent definitions (e.g. the legacy PoE action) must follow the config even when offline.
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()

		await this.refreshDevices()
		this.schedulePoll()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.knownSites)
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	getDeviceChoices(): DropdownChoice[] {
		return this.devices.map((device) => ({ id: device.id, label: `${device.name} (${device.model})` }))
	}

	/** Variable slug per device ID, unique across all devices (see variables.ts buildDeviceSlugs). */
	getDeviceSlugs(): Map<string, string> {
		return this.deviceSlugs
	}

	/** Device dropdown limited to switches (only those have ports), used by the power cycle/PoE actions and feedbacks. */
	getSwitchChoices(): DropdownChoice[] {
		return this.devices
			.filter((device) => device.features.includes('switching'))
			.map((device) => ({ id: device.id, label: `${device.name} (${device.model})` }))
	}

	/** All PoE capable port indices of a single switch (sorted). */
	getSwitchPortChoices(deviceId: string): DropdownChoice[] {
		const indices = new Set<number>()
		for (const port of this.deviceDetails.get(deviceId)?.ports ?? []) {
			if (!port.poe) continue
			indices.add(port.idx)
		}
		return Array.from(indices)
			.sort((a, b) => a - b)
			.map((idx) => ({ id: idx, label: `Port ${idx}` }))
	}

	/** ID of the port dropdown that is generated per switch and shown/hidden dynamically. */
	portFieldId(deviceId: string): string {
		return `portIdx__${deviceId}`
	}

	/**
	 * Builds a "Switch" dropdown plus one hidden port dropdown per switch that only offers the real ports of
	 * that switch. Companion cannot filter a dropdown based on another option, but `isVisibleExpression` can
	 * show/hide whole fields - so only the port field matching the selected switch is visible. To the user it
	 * looks like a single "Port" field that never offers more ports than the selected switch actually has.
	 */
	getSwitchAndPortFields(): CompanionInputFieldDropdown[] {
		const switchChoices = this.getSwitchChoices()
		const fields: CompanionInputFieldDropdown[] = [
			{
				type: 'dropdown',
				id: 'deviceId',
				label: 'Switch',
				tooltip: 'A switch MAC address is accepted as well (used by actions migrated from older module versions).',
				choices: switchChoices,
				default: switchChoices[0]?.id ?? '',
				allowCustom: true,
				disableAutoExpression: true,
			},
		]

		for (const { id: deviceId } of switchChoices) {
			const portChoices = this.getSwitchPortChoices(String(deviceId))
			fields.push({
				type: 'dropdown',
				id: this.portFieldId(String(deviceId)),
				label: 'Port',
				choices: portChoices,
				default: portChoices[0]?.id ?? 1,
				isVisibleExpression: `$(options:deviceId) == "${deviceId}"`,
			})
		}

		return fields
	}

	/**
	 * Resolves the selected switch to a device ID. Besides the device ID itself a MAC address is accepted,
	 * which is what actions migrated from the old node-unifi based module versions contain.
	 */
	resolveSwitchId(value: string): string {
		if (!value) return ''
		if (this.devices.some((device) => device.id === value)) return value
		const mac = normalizeMac(value)
		const match = this.devices.find((device) => normalizeMac(device.macAddress) === mac)
		if (match) return match.id
		// A MAC address that matches no known device must not be sent to the API as a device ID.
		return MAC_PATTERN.test(value) ? '' : value
	}

	/** Reads the switch/port selection of an action or feedback built with getSwitchAndPortFields. */
	getPortSelection(options: CompanionOptionValues): { deviceId: string; portIdx: number } | undefined {
		const rawDeviceId = typeof options.deviceId === 'string' ? options.deviceId.trim() : ''
		if (!rawDeviceId) return undefined
		const deviceId = this.resolveSwitchId(rawDeviceId)
		if (!deviceId) return undefined
		// Migrated actions (switch given as MAC address) carry their port in the migration key; a per switch port
		// field may only exist there as a default value filled in by Companion, so it must not take precedence.
		const portValue = MAC_PATTERN.test(rawDeviceId)
			? (options[MIGRATED_PORT_OPTION] ?? options[this.portFieldId(deviceId)])
			: (options[this.portFieldId(deviceId)] ?? options[MIGRATED_PORT_OPTION])
		const portIdx = Number(portValue)
		if (!Number.isInteger(portIdx) || portIdx < 1) return undefined
		return { deviceId, portIdx }
	}

	/** Dropdown choices of all clients seen so far, sorted alphabetically - used by the clientOnline feedback. */
	getClientChoices(): DropdownChoice[] {
		return Array.from(this.knownClients.values())
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((client) => ({
				id: client.macAddress,
				label: `${client.name}${client.ipAddress ? ` (${client.ipAddress})` : ''}`,
			}))
	}

	/** Whether the client with this MAC address is currently connected to the network. */
	isClientOnline(macAddress: string): boolean {
		return this.connectedClientMacs.has(macAddress.toLowerCase())
	}

	/** Number of clients currently connected to a specific device (e.g. an access point). */
	getClientCount(deviceId: string): number {
		return this.clientCountByUplink.get(deviceId) ?? 0
	}

	private clientConfig(): UnifiClientConfig {
		return {
			host: this.config.host,
			port: this.config.port,
			siteId: this.resolvedSiteId || this.config.siteId,
			apiKey: this.secrets.apiKey,
			verifyTls: this.config.verifyTls === true,
		}
	}

	private clearSiteData(): void {
		this.devices = []
		this.deviceDetails = new Map()
		this.deviceSlugs = new Map()
		this.skippedDevices = []
		this.knownClients = new Map()
		this.connectedClientMacs = new Set()
		this.clientCountByUplink = new Map()
		this.knownSites = []
		this.resolvedSiteId = ''
		this.applicationVersion = ''
	}

	/**
	 * Resolves the configured site ID against `GET /sites`. The Integration API only accepts real site UUIDs -
	 * unlike the old API it has no "default" alias. So that the default config value ("default") still works,
	 * the site is matched by name/internalReference/ID; with exactly one site that site is always used,
	 * regardless of the configured value.
	 */
	private async resolveSiteId(): Promise<UnifiResult<{ siteId: string; sites: UnifiSite[] }>> {
		const sitesResult = await listSites(this.clientConfig())
		if (sitesResult.outcome !== 'ok') return sitesResult
		const sites = sitesResult.data

		if (sites.length > 1) {
			this.log('info', `Multiple sites found: ${sites.map((site) => `${site.name} (${site.id})`).join(', ')}`)
		}

		if (sites.length === 1) {
			return { outcome: 'ok', data: { siteId: sites[0].id, sites } }
		}

		const wanted = this.config.siteId?.trim()
		const match = sites.find((site) => site.id === wanted || site.internalReference === wanted || site.name === wanted)
		if (!match) return { outcome: 'not-found' }
		return { outcome: 'ok', data: { siteId: match.id, sites } }
	}

	/** One legacy session per connection, created on first use (see unifi-legacy-client.ts). */
	private getLegacyClient(): UnifiLegacyClient {
		if (!this.legacyClient) {
			// The legacy API addresses sites by their short name (internalReference, e.g. "default"), not by UUID.
			const site = this.knownSites.find((candidate) => candidate.id === this.resolvedSiteId)
			this.legacyClient = new UnifiLegacyClient({
				host: this.config.host,
				port: this.config.port,
				siteId: site?.internalReference || this.config.siteId,
				username: this.config.legacyUsername,
				password: this.secrets.legacyPassword,
				verifyTls: this.config.verifyTls === true,
			})
		}
		return this.legacyClient
	}

	private async resetLegacyClient(): Promise<void> {
		const client = this.legacyClient
		this.legacyClient = undefined
		await client?.logout()
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer)
			this.pollTimer = undefined
		}
	}

	/** Schedules the next poll only after the previous one has finished, so polls can never pile up. */
	private schedulePoll(): void {
		this.stopPolling()

		const seconds = this.config.pollInterval
		if (this.destroyed || !seconds || seconds <= 0) return

		const generation = this.generation
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined
			void this.pollState().finally(() => {
				if (generation === this.generation) this.schedulePoll()
			})
		}, seconds * 1000)
	}

	/** Runs refresh/poll work one after another; work queued under an older generation is skipped. */
	private async enqueue(work: (generation: number) => Promise<void>): Promise<void> {
		const generation = this.generation
		this.refreshQueue = this.refreshQueue
			.then(async () => {
				if (generation === this.generation) await work(generation)
			})
			.catch((error) => {
				this.log('error', `Refresh failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		return this.refreshQueue
	}

	private isStale(generation: number): boolean {
		return generation !== this.generation
	}

	/** Reloads the complete device/port list and rebuilds dropdown choices and presets. */
	async refreshDevices(): Promise<void> {
		return this.enqueue(async (generation) => this.doRefreshDevices(generation))
	}

	/** Regular, lightweight poll: online state + PoE state, without rebuilding dropdowns/presets. */
	async pollState(): Promise<void> {
		return this.enqueue(async (generation) => this.doPollState(generation))
	}

	private async doRefreshDevices(generation: number): Promise<void> {
		if (!this.config.host || !this.secrets.apiKey) {
			this.clearSiteData()
			this.rebuildDefinitions()
			this.updateStatus(InstanceStatus.BadConfig, 'Host and API key are required.')
			return
		}

		const infoResult = await getApplicationInfo(this.clientConfig())
		if (this.isStale(generation)) return
		if (infoResult.outcome !== 'ok') {
			this.applyConnectionError(infoResult, 'Connection to the UniFi console failed.')
			return
		}
		this.applicationVersion = infoResult.data.applicationVersion

		const siteResult = await this.resolveSiteId()
		if (this.isStale(generation)) return
		if (siteResult.outcome !== 'ok') {
			this.applyConnectionError(siteResult, `Site "${this.config.siteId}" could not be resolved.`)
			return
		}
		if (siteResult.data.siteId !== this.resolvedSiteId) this.clearSiteData()
		this.knownSites = siteResult.data.sites
		this.resolvedSiteId = siteResult.data.siteId

		const devicesResult = await listDevices(this.clientConfig())
		if (this.isStale(generation)) return
		if (devicesResult.outcome !== 'ok') {
			this.applyConnectionError(devicesResult, 'Device list could not be loaded.')
			return
		}
		this.setDevices(devicesResult.data)

		const warnings = await this.refreshSwitchPortDetails(generation)
		if (this.isStale(generation)) return
		const clientsResult = await this.refreshClients(generation)
		if (this.isStale(generation)) return
		if (clientsResult.warning) warnings.push(clientsResult.warning)

		this.rebuildDefinitions()
		this.applyPollResult(warnings)
	}

	private async doPollState(generation: number): Promise<void> {
		if (!this.config.host || !this.secrets.apiKey) return

		// Without a resolved site (e.g. the console was unreachable at startup) only a full refresh can recover.
		if (!this.resolvedSiteId) return this.doRefreshDevices(generation)

		const devicesResult = await listDevices(this.clientConfig())
		if (this.isStale(generation)) return
		if (devicesResult.outcome !== 'ok') {
			this.applyConnectionError(devicesResult, 'Polling failed.')
			return
		}
		const devicesChanged = this.setDevices(devicesResult.data)

		const warnings = await this.refreshSwitchPortDetails(generation)
		if (this.isStale(generation)) return
		const clientsResult = await this.refreshClients(generation)
		if (this.isStale(generation)) return
		if (clientsResult.warning) warnings.push(clientsResult.warning)

		if (devicesChanged) {
			this.rebuildDefinitions()
		} else if (clientsResult.hasNewClients) {
			this.updateVariableDefinitions()
			this.updateFeedbacks()
		}
		this.applyPollResult(warnings)
	}

	/** Stores the device list; returns whether devices were added, removed or renamed. */
	private setDevices(rawDevices: UnifiDevice[]): boolean {
		const { devices, skipped } = partitionValidDevices(rawDevices)
		this.skippedDevices = skipped
		const signature = (list: UnifiDevice[]): string =>
			list
				.map((device) => `${device.id}|${device.name}|${device.features.join(',')}`)
				.sort()
				.join('\n')
		const changed = signature(devices) !== signature(this.devices)
		this.devices = devices
		this.deviceSlugs = buildDeviceSlugs(devices)
		return changed
	}

	private rebuildDefinitions(): void {
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
	}

	private applyPollResult(pollWarnings: string[]): void {
		const warnings =
			this.skippedDevices.length > 0
				? [
						`Skipped ${this.skippedDevices.length} device(s) without a valid ID from the console: ` +
							`${this.skippedDevices.join(', ')}. Updating UniFi Network usually fixes this.`,
						...pollWarnings,
					]
				: pollWarnings
		if (warnings.length > 0) {
			this.updateStatus(InstanceStatus.UnknownWarning, warnings.join(' '))
			for (const warning of warnings) this.log('warn', warning)
		} else {
			this.updateStatus(InstanceStatus.Ok)
		}
		this.checkFeedbacks('deviceOnline', 'portPoePowered', 'clientOnline')
		this.updateConnectionVariables()
		this.updateDeviceAndPortVariables()
		this.updateClientVariables()
	}

	/**
	 * Rebuilds the port details for the current switches. Removed switches are dropped; for a switch whose
	 * details cannot be loaded the last known state is kept and a warning is returned (shown in the status).
	 */
	private async refreshSwitchPortDetails(generation: number): Promise<string[]> {
		const warnings: string[] = []
		const details = new Map<string, UnifiDeviceDetail>()
		const switches = this.devices.filter((device) => device.features.includes('switching'))
		for (const device of switches) {
			const detailResult = await getDevice(this.clientConfig(), device.id)
			if (this.isStale(generation)) return warnings
			if (detailResult.outcome === 'ok') {
				details.set(device.id, detailResult.data)
			} else {
				const previous = this.deviceDetails.get(device.id)
				if (previous) details.set(device.id, previous)
				warnings.push(`Port state of ${device.name} could not be loaded (${detailResult.outcome}).`)
			}
		}
		this.deviceDetails = details
		return warnings
	}

	/**
	 * Queries the currently connected clients and maintains `knownClients`/`connectedClientMacs`.
	 * The clients API only returns connected clients (there is no "OFFLINE" state), so the module remembers
	 * every client it has seen and derives "offline" from a client missing in the current response.
	 */
	private async refreshClients(generation: number): Promise<{ hasNewClients: boolean; warning?: string }> {
		const clientsResult = await listClients(this.clientConfig())
		if (this.isStale(generation)) return { hasNewClients: false }
		if (clientsResult.outcome !== 'ok') {
			return { hasNewClients: false, warning: `Clients could not be queried (${clientsResult.outcome}).` }
		}

		let hasNewClients = false
		const connectedMacs = new Set<string>()
		const countByUplink = new Map<string, number>()
		for (const client of clientsResult.data) {
			if (client.uplinkDeviceId) {
				countByUplink.set(client.uplinkDeviceId, (countByUplink.get(client.uplinkDeviceId) ?? 0) + 1)
			}
			// VPN/Teleport clients have no MAC address and cannot be tracked by it.
			if (!client.macAddress) continue
			const macAddress = client.macAddress.toLowerCase()
			connectedMacs.add(macAddress)
			if (!this.knownClients.has(macAddress)) hasNewClients = true
			this.knownClients.set(macAddress, {
				name: client.name || macAddress,
				ipAddress: client.ipAddress,
				macAddress,
			})
		}
		this.connectedClientMacs = connectedMacs
		this.clientCountByUplink = countByUplink
		return { hasNewClients }
	}

	/** Updates the client_<mac>_online variables from `connectedClientMacs`. */
	private updateClientVariables(): void {
		const values: Record<string, string | number> = {}
		for (const client of this.knownClients.values()) {
			values[`client_${slugifyMac(client.macAddress)}_online`] = this.connectedClientMacs.has(client.macAddress)
				? 'Online'
				: 'Offline'
		}
		this.setVariableValues(values)
	}

	private updateConnectionVariables(): void {
		this.setVariableValues({
			connection_status: 'ok',
			application_version: this.applicationVersion,
			site_id: this.resolvedSiteId || this.config.siteId,
			device_count: this.devices.length,
			device_count_online: this.devices.filter((device) => device.state === 'ONLINE').length,
			last_poll_time: new Date().toLocaleString(),
			last_action_result: this.lastActionResult,
		})
	}

	/** Updates the variables generated per device/port (link/PoE state). */
	private updateDeviceAndPortVariables(): void {
		const values: Record<string, string | number> = {}

		for (const device of this.devices) {
			const slug = this.deviceSlugs.get(device.id)
			if (!slug) continue
			values[`device_${slug}_online`] = device.state === 'ONLINE' ? 'Online' : 'Offline'
			if (device.features.includes('accessPoint')) {
				values[`device_${slug}_client_count`] = this.getClientCount(device.id)
			}
		}

		for (const [deviceId, detail] of this.deviceDetails) {
			const slug = this.deviceSlugs.get(deviceId)
			if (!slug) continue
			for (const port of detail.ports ?? []) {
				if (!port.poe) continue
				values[`port_${slug}_${port.idx}_link`] = port.state === 'UP' ? 'up' : 'down'
				values[`port_${slug}_${port.idx}_poe`] = port.poe.state === 'UP' ? 'up' : 'down'
				values[`port_${slug}_${port.idx}_poe_enabled`] = port.poe.enabled ? 'ON' : 'OFF'
			}
		}

		this.setVariableValues(values)
	}

	private applyConnectionError(result: UnifiResult<unknown>, context: string): void {
		const detail = result.outcome === 'error' ? result.message : result.outcome
		const fullMessage = `${context} (${detail})`

		if (result.outcome === 'unauthorized') {
			this.updateStatus(InstanceStatus.AuthenticationFailure, fullMessage)
		} else if (result.outcome === 'not-found') {
			this.updateStatus(InstanceStatus.UnknownError, fullMessage)
		} else {
			this.updateStatus(InstanceStatus.ConnectionFailure, fullMessage)
		}
		this.setVariableValues({ connection_status: result.outcome })
		this.log('warn', fullMessage)
	}

	async restartDevice(deviceId: string): Promise<void> {
		const result = await restartDeviceRequest(this.clientConfig(), deviceId)
		this.recordActionResult(`restartDevice(${deviceId})`, result)
	}

	async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
		const result = await powerCyclePortRequest(this.clientConfig(), deviceId, portIdx)
		this.recordActionResult(`powerCyclePort(${deviceId}:${portIdx})`, result)
	}

	/** Legacy path: persistent PoE on/off via the private controller API (see unifi-legacy-client.ts). */
	async setPortPoePersistent(deviceId: string, portIdx: number, enabled: boolean): Promise<void> {
		if (!this.config.legacyUsername || !this.secrets.legacyPassword) {
			this.log(
				'warn',
				'setPortPoePersistent: legacy username/password missing - enter a local admin account in the connection settings.',
			)
			return
		}
		const device = this.devices.find((candidate) => candidate.id === deviceId)
		if (!device) {
			this.log('warn', `setPortPoePersistent: device ${deviceId} not found in cache - refresh the device list first.`)
			return
		}

		const result = await this.getLegacyClient().setPortPoeMode(device.macAddress, portIdx, enabled ? 'auto' : 'off')
		this.recordActionResult(`setPortPoePersistent(${deviceId}:${portIdx}, ${enabled ? 'on' : 'off'})`, result)

		if (result.outcome === 'ok') await this.pollState()
	}

	private recordActionResult(label: string, result: { outcome: string; message?: string }): void {
		this.lastActionResult = `${label}: ${result.outcome}${result.message ? ` (${result.message})` : ''}`
		this.setVariableValues({ last_action_result: this.lastActionResult })

		if (result.outcome === 'ok') {
			this.log('info', `${label} succeeded.`)
		} else {
			this.log('warn', `${label} failed: ${result.outcome}${result.message ? ` - ${result.message}` : ''}`)
		}
	}
}
