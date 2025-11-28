// @ts-check

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import unifi from 'node-unifi'
import pQueue from 'p-queue'
import { getActionDefinitions } from './actions.js'
import { getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'

export class UnifiInstance extends InstanceBase {
	queue = new pQueue({
		concurrency: 1,
	})

	loggedIn = false

	connectionCheckInterval = 10000 // Note: this must be more than the timeout used in node-unifi
	/**
	 * @type {NodeJS.Timer}
	 */
	connectionCheckTimer

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

		this.updateStatus(InstanceStatus.Ok)

		this.setActionDefinitions(getActionDefinitions(this))

		await this.configUpdated(config)

		this.connectionCheckTimer = setInterval(() => {
			if (this.controller) {
				if (this.loggedIn) {
					// Arbitrary call to check authentication
					this.controller._ensureLoggedIn().catch((e) => {
						this.loggedIn = false

						this.log('error', `Status check failed: ${e?.message ?? e}`)

						// TODO - pass error message
						this.updateStatus(InstanceStatus.Disconnected)
					})
				}
			}
		}, this.connectionCheckInterval)
	}

	#loginRunning = false
	#doLogin() {
		if (this.#loginRunning || !this.controller) return

		this.#loginRunning = true
		this.updateStatus(InstanceStatus.Connecting)

		// TODO - make sure the result is for the same credentials as when it was fired
		this.controller
			.login()
			.then(() => {
				this.loggedIn = true

				this.updateStatus(InstanceStatus.Ok)

				this.refreshActionInfo().catch(() => null)
			})
			.catch((e) => {
				this.loggedIn = false

				// TODO - pass error message
				this.updateStatus(InstanceStatus.ConnectionFailure)
			})
			.finally(() => {
				this.#loginRunning = false
			})
	}

	async refreshActionInfo() {
		if (!this.controller) return

		try {
			const portProfileConfigs = await this.controller.getPortConfig()

			this.portProfileOptions = portProfileConfigs.map((profile) => ({
				id: profile.name,
				label: profile.name,
			}))
		} catch (e) {
			this.log('warn', `Failed to load port profile list: ${e?.message ?? e}`)
		}

		try {
			const devicesBasic = await this.controller.getAccessDevicesBasic()

			this.switchMacAddressOptions = devicesBasic.map((device) => ({
				id: device.mac,
				label: `${device.name} (${device.mac})`,
			}))
		} catch (e) {
			this.log('warn', `Failed to load port profile list: ${e?.message ?? e}`)
		}

		try {
			const wifiNetworks = await this.getWifiNetworks()
			this.wifiNetworkOptions = (wifiNetworks ?? []).map((network) => ({
				id: network.name,
				label: network.name,
			}))
		} catch (e) {
			this.log('warn', `Failed to load wifi network list: ${e?.message ?? e}`)
		}

		this.setActionDefinitions(getActionDefinitions(this))
	}

	async configUpdated(config) {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.loggedIn = false
		if (this.controller !== undefined) {
			this.controller.removeAllListeners()

			this.controller.logout().catch(() => null)

			delete this.controller
		}

		this.portProfileOptions = []
		this.switchMacAddressOptions = []

		this.controller = new unifi.Controller({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username,
			password: this.config.password,
			token2FA: this.config.token2FA,
			sslverify: !!this.config.sslverify,
			site: this.config.site,
		})

		this.#doLogin()
	}

	async destroy() {
		clearInterval(this.connectionCheckTimer)

		if (this.controller) {
			this.controller.removeAllListeners()
			await this.controller.logout().catch(() => null)
		}
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async doPowerCyclePort(switch_mac, port_idx) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		try {
			await this.controller.powerCycleSwitchPort(switch_mac, port_idx)
		} catch (e) {
			this.handleErrors(e, `Power cycle port ${switch_mac}@${port_idx}`)
		}
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 * @param {string} poe_mode
	 */
	async changePortPOEMode(switch_mac, port_idx, poe_mode) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		try {
			const device = (await this.controller.getAccessDevices(switch_mac))[0]
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

			await this.controller.setDeviceSettingsBase(deviceId, { port_overrides: portOverrides })
		} catch (e) {
			this.handleErrors(e, `Change port POE mode ${switch_mac}@${port_idx}`)
		}
	}

	/**
	 * @param {string} profile_name
	 * @param {string} poe_mode
	 */
	async changePortProfilePOEMode(profile_name, poe_mode) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		try {
			const portProfileConfigs = await this.controller.getPortConfig()

			const profileConfig = portProfileConfigs.find((profile) => profile.name == profile_name)
			if (!profileConfig) throw new Error('Port profile not found')

			profileConfig.poe_mode = poe_mode

			await this.controller.customApiRequest(
				'/api/s/<SITE>/rest/portconf/' + profileConfig._id,
				// @ts-ignore
				'PUT',
				profileConfig
			)
		} catch (e) {
			this.handleErrors(e, `Change port profile POE mode ${profile_name}`)
		}
	}

	/**
	 */
	async getWifiNetworks() {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		try {
			const wifiNetworks = await this.controller.getWLanSettings()

			this.log('debug', 'Fetched wifi networks: ' + wifiNetworks.map((n) => n.name).join(', '))
			//console.log('Wifi networks data: ' + JSON.stringify(wifiNetworks))
			return wifiNetworks
		} catch (e) {
			this.handleErrors(e, `getWifiNetworks`)
		}
	}

	/**
	 * https://github.com/uchkunrakhimow/unifi-best-practices?tab=readme-ov-file#%EF%B8%8F-network-configuration
	 * https://github.com/jens-maus/node-unifi/blob/master/unifi.js
	 * @param {string} wifiNetworkName
	 * @param {{name?:string,x_passphrase?:string}} updates
	 */
	async updateWifiNetwork(wifiNetworkName, updates) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')
		try {
			const wifiNetworks = await this.controller.getWLanSettings()
			const wifiNetwork = wifiNetworks.find((n) => n.name == wifiNetworkName)
			if (!wifiNetwork) throw new Error('WiFi Network not found')
			
			this.log('debug', `Updating WiFi Network ${wifiNetworkName} with ID ${wifiNetwork._id} with updates: ${JSON.stringify(updates)}`)
			await this.controller.setWLanSettingsBase(wifiNetwork._id, updates)
		} catch (e) {
			this.handleErrors(e, `updateWifiNetwork ${wifiNetworkName}`)
		}
	}

	/**
	 * @param {string} wifiNetworkName
	 */
	async deleteWLan(wifiNetworkName) {
		try {
			const wifiNetworks = await this.controller.getWLanSettings()
			const wifiNetwork = wifiNetworks.find((n) => n.name == wifiNetworkName)
			if (!wifiNetwork) throw new Error('WiFi Network not found')

			this.log('debug', `Deleting WiFi Network ${wifiNetworkName} with ID ${wifiNetwork._id}`)
			//await this.controller.deleteWLan(wifiNetwork._id) // seems to have mixed up method and payload
			await this.controller.customApiRequest(
				'/api/s/<SITE>/rest/wlanconf/' + wifiNetwork._id.trim(), 'DELETE')
		} catch (e) {
			this.handleErrors(e, `deleteWLan ${wifiNetworkName}`)
		}
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
