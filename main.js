// @ts-check

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import unifi from 'node-unifi'
import pQueue from 'p-queue'
import { getActionDefinitions } from './actions.js'
import { getConfigFields } from './config.js'

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
			.then((ok) => {
				this.loggedIn = true

				this.updateStatus(InstanceStatus.Ok)
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

	async configUpdated(config) {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.loggedIn = false
		if (this.controller !== undefined) {
			this.controller.removeAllListeners()

			this.controller.logout().catch(() => null)

			delete this.controller
		}

		this.controller = new unifi.Controller({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username,
			password: this.config.password,
			sslverify: false, // TODO - make config
			// TODO - move site here?
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
	 * @param {string} site
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async doPowerCyclePort(site, switch_mac, port_idx) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		try {
			// TODO - site
			await this.controller.powerCycleSwitchPort(switch_mac, port_idx)
		} catch (e) {
			this.handleErrors(e, `Power cycle port ${switch_mac}@${port_idx}`)
		}
	}

	/**
	 * @param {string} site
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 * @param {string} poe_mode
	 */
	async changePortPOEMode(site, switch_mac, port_idx, poe_mode) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		// TODO - site

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
	 * @param {string} site
	 * @param {string} profile_name
	 * @param {string} poe_mode
	 */
	async changePortProfilePOEMode(site, profile_name, poe_mode) {
		if (!this.controller) throw new Error('Not initialised')
		if (!this.loggedIn) throw new Error('Not logged in')

		// TODO - site

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

runEntrypoint(UnifiInstance, [])
