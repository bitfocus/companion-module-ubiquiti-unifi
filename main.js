// @ts-check

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import unifi from 'node-unifi'
import { startConnectionLoop, withTimeout, isAuthError } from './connection.js'
import pQueue from 'p-queue'
import { getActionDefinitions } from './actions.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getVariableDefinitions } from './variables.js'
import { getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'

// How long a button press waits for an in-progress (re)connect before giving up.
const ACTION_CONNECT_WAIT = 15000
// Upper bound for one action so a hung request can never wedge the action queue.
const ACTION_TIMEOUT = 30000

/**
 * Best-effort teardown of a controller session, including its keep-alive sockets.
 * @param {any} controller
 */
function disposeController(controller) {
	controller.removeAllListeners?.()
	const agents = controller._instance?.defaults
	Promise.resolve()
		.then(() => controller._isInit && withTimeout(controller.logout(), 5000, 'Logout'))
		.catch(() => null)
		.finally(() => {
			agents?.httpAgent?.destroy?.()
			agents?.httpsAgent?.destroy?.()
		})
}

/** @param {Date} date */
function formatTime(date) {
	return date.toLocaleTimeString([], { hour12: false })
}

export class UnifiInstance extends InstanceBase {
	queue = new pQueue({
		concurrency: 1,
	})

	loggedIn = false

	/** @type {'ok' | 'connecting' | 'failed'} */
	connectionStatus = 'connecting'
	lastActionFailed = false
	reconnectCount = 0

	/** @type {import('node-unifi').Controller | undefined} */
	controller

	/** @type {ReturnType<typeof startConnectionLoop> | undefined} */
	connection

	/**
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	portProfileOptions = []
	/**
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	switchMacAddressOptions = []

	getConfigFields() {
		return getConfigFields()
	}

	async init(config) {
		this.config = config

		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setVariableDefinitions(getVariableDefinitions())
		this.setVariableValues({
			connection_status: this.connectionStatus,
			last_error: '',
			last_connected: '',
			last_action: '',
			last_action_result: '',
			last_action_time: '',
		})

		await this.configUpdated(config)
	}

	/**
	 * @param {import('node-unifi').Controller} controller
	 * @param {() => boolean} isCurrent
	 */
	async #refreshActionInfo(controller, isCurrent) {
		if (!isCurrent()) return

		try {
			const portProfileConfigs = await controller.getPortConfig()

			if (!isCurrent()) return
			this.portProfileOptions = portProfileConfigs.map((profile) => ({
				id: profile.name,
				label: profile.name,
			}))
		} catch (e) {
			if (!isCurrent()) return
			this.log('warn', `Failed to load port profile list: ${e?.message ?? e}`)
		}

		try {
			const devicesBasic = await controller.getAccessDevicesBasic()

			if (!isCurrent()) return
			this.switchMacAddressOptions = devicesBasic.map((device) => ({
				id: device.mac,
				label: `${device.name} (${device.mac})`,
			}))
		} catch (e) {
			if (!isCurrent()) return
			this.log('warn', `Failed to load switch list: ${e?.message ?? e}`)
		}

		if (isCurrent()) this.setActionDefinitions(getActionDefinitions(this))
	}

	async configUpdated(config) {
		this.connection?.stop()
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.loggedIn = false
		this.controller = undefined
		this.portProfileOptions = []
		this.switchMacAddressOptions = []
		this.reconnectCount = 0
		this.setVariableValues({ reconnect_count: 0, last_error: '' })
		this.#setConnectionStatus('connecting')

		let lastFailure
		let everConnected = false
		const connection = startConnectionLoop({
			connect: async () => {
				const controller = this.#createController()
				try {
					await controller.login()
				} catch (e) {
					disposeController(controller)
					throw e
				}
				return controller
			},
			check: (controller) => controller.getAccessDevicesBasic(),
			refresh: (controller, isCurrent) => this.#refreshActionInfo(controller, isCurrent),
			dispose: (controller) => {
				if (this.controller === controller) this.controller = undefined
				disposeController(controller)
			},
			onConnecting: () => {
				this.loggedIn = false
				this.updateStatus(InstanceStatus.Connecting)
				// Stay 'failed' across retries so a red button doesn't flash on every attempt.
				if (this.connectionStatus !== 'failed') this.#setConnectionStatus('connecting')
			},
			onConnected: (controller) => {
				if (!this.loggedIn) {
					this.log('info', 'Connected to UniFi controller')
					if (everConnected) this.reconnectCount++
					everConnected = true
					this.setVariableValues({
						last_connected: formatTime(new Date()),
						reconnect_count: this.reconnectCount,
					})
				}
				lastFailure = undefined
				this.controller = controller
				this.loggedIn = true
				this.updateStatus(InstanceStatus.Ok)
				this.#setConnectionStatus('ok')
			},
			onFailure: (error) => {
				this.loggedIn = false
				const message = `${error?.message ?? error}`
				// Log each distinct failure once instead of every retry.
				this.log(
					message === lastFailure ? 'debug' : 'warn',
					`Connection check failed; retrying automatically: ${message}`,
				)
				lastFailure = message
				this.updateStatus(InstanceStatus.ConnectionFailure, message)
				this.setVariableValues({ last_error: message })
				this.#setConnectionStatus('failed')
			},
		})
		this.connection = connection
	}

	/** @param {'ok' | 'connecting' | 'failed'} status */
	#setConnectionStatus(status) {
		if (this.connectionStatus === status) return
		this.connectionStatus = status
		this.setVariableValues({ connection_status: status })
		this.checkFeedbacks('connectionState')
	}

	/**
	 * @param {string} context
	 * @param {string} result
	 */
	#recordAction(context, result) {
		this.lastActionFailed = result !== 'ok'
		this.setVariableValues({
			last_action: context,
			last_action_result: result,
			last_action_time: formatTime(new Date()),
		})
		this.checkFeedbacks('lastActionFailed')
	}

	#createController() {
		return new unifi.Controller({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username,
			password: this.config.password,
			token2FA: this.config.token2FA,
			sslverify: !!this.config.sslverify,
			site: this.config.site,
		})
	}

	async destroy() {
		this.loggedIn = false
		this.connection?.stop()
		this.controller = undefined
	}

	/**
	 * Runs an action against a connected controller. If the session turns out to be stale
	 * (401/403, so the controller did not apply the request), reconnect and try once more.
	 * @param {string} context
	 * @param {(controller: import('node-unifi').Controller) => Promise<unknown>} fn
	 */
	async #runAction(context, fn) {
		const connection = this.connection
		if (!connection) throw new Error('Not initialised')

		try {
			for (let attempt = 1; ; attempt++) {
				const controller = await connection.whenConnected(ACTION_CONNECT_WAIT)
				try {
					await withTimeout(fn(controller), ACTION_TIMEOUT, context)
					this.#recordAction(context, 'ok')
					return
				} catch (e) {
					if (attempt > 1 || !isAuthError(e) || !connection.isCurrent()) throw e
					this.log('warn', `${context}: session rejected by controller, reconnecting and retrying once`)
					connection.reconnect()
				}
			}
		} catch (e) {
			this.#recordAction(context, `failed: ${e?.message ?? e}`)
			this.handleErrors(e, context)
		}
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async doPowerCyclePort(switch_mac, port_idx) {
		await this.#runAction(`Power cycle port ${switch_mac}@${port_idx}`, (controller) =>
			controller.powerCycleSwitchPort(switch_mac, port_idx),
		)
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 * @param {string} poe_mode
	 */
	async changePortPOEMode(switch_mac, port_idx, poe_mode) {
		await this.#runAction(`Change port POE mode ${switch_mac}@${port_idx}`, async (controller) => {
			const device = (await controller.getAccessDevices(switch_mac))[0]
			if (!device) throw new Error('No device found')
			if (!device.port_overrides || !device._id) throw new Error('Device invalid')

			const deviceId = device._id
			const portOverrides = device.port_overrides

			// TODO - can this be more granular?
			const selectedPort = portOverrides.find((port) => port.port_idx == port_idx)
			if (selectedPort) {
				selectedPort.poe_mode = poe_mode
			} else {
				portOverrides.push({
					port_idx: Number(port_idx),
					poe_mode: poe_mode,
				})
			}

			await controller.setDeviceSettingsBase(deviceId, { port_overrides: portOverrides })
		})
	}

	/**
	 * @param {string} profile_name
	 * @param {string} poe_mode
	 */
	async changePortProfilePOEMode(profile_name, poe_mode) {
		await this.#runAction(`Change port profile POE mode ${profile_name}`, async (controller) => {
			const portProfileConfigs = await controller.getPortConfig()

			const profileConfig = portProfileConfigs.find((profile) => profile.name == profile_name)
			if (!profileConfig) throw new Error('Port profile not found')

			profileConfig.poe_mode = poe_mode

			await controller.customApiRequest(
				'/api/s/<SITE>/rest/portconf/' + profileConfig._id,
				// @ts-ignore
				'PUT',
				profileConfig,
			)
		})
	}

	/**
	 * @param {Error} err
	 * @param {string} context
	 */
	handleErrors(err, context) {
		// if (err == 'api.err.Invalid') {
		// 	this.log('error', 'Username or Password invalid')
		// } else if (err == 'api.err.LoginRequired') {
		// 	this.log('error', 'Failed to login')
		// } else if (err == 'api.err.UnknownDevice') {
		// 	this.log('warn', 'Device "' + attributes['mac'] + '" does not exist')
		// } else if (err == 'api.err.InvalidPayload' || err == 'api.err.InvalidTargetPort') {
		// 	this.log('warn', 'Port "' + attributes['switchPort'] + '" does not exist or POE is not currently active on it')
		// } else if (err == 'api.err.UnknownProfile') {
		// 	this.log('warn', 'Port Profile ' + attributes['profile'] + ' not found')
		// } else if (err == 'Host_Timeout') {
		// 	this.log('error', 'ERROR: Host Timedout')
		// 	this.updateStatus(InstanceStatus.ConnectionFailure)
		// } else if (err.includes('EHOSTDOWN')) {
		// 	this.log('error', 'ERROR: Host not found')
		// 	this.updateStatus(InstanceStatus.ConnectionFailure)
		// } else {
		this.log('error', `ERROR for ${context}: ${err?.message ?? err}`)
		// }
	}
}

runEntrypoint(UnifiInstance, UpgradeScripts)
