// @ts-check

/**
 * @param {import("./main.js").UnifiInstance} self
 * @returns {import("@companion-module/base").CompanionActionDefinitions}
 */
export function getActionDefinitions(self) {
	return {
		POECycle: {
			name: 'Switchport: Power Cycle',
			options: [
				{
					type: 'dropdown',
					label: 'Switch Mac Address',
					id: 'mac',
					default: '',
					allowCustom: true,
					choices: self.switchMacAddressOptions,
				},
				{
					type: 'number',
					label: 'Port',
					id: 'port',
					default: 1,
					min: 1,
					max: 100,
				},
			],
			callback: async (action) => {
				await self.queue.add(async () => {
					await self.doPowerCyclePort(action.options.mac + '', Number(action.options.port))
				})
			},
		},
		POEMode: {
			name: 'Switchport: Set POE mode',
			options: [
				{
					type: 'dropdown',
					label: 'Switch Mac Address',
					id: 'mac',
					default: '',
					allowCustom: true,
					choices: self.switchMacAddressOptions,
				},
				{
					type: 'number',
					label: 'Port',
					id: 'port',
					default: 1,
					min: 1,
					max: 100,
				},
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: [
						{ id: 'auto', label: 'Auto' },
						{ id: 'pasv24', label: '24V Passive' },
						{ id: 'off', label: 'Off' },
					],
					default: 'auto',
				},
			],
			callback: async (action) => {
				await self.queue.add(async () => {
					await self.changePortPOEMode(action.options.mac + '', Number(action.options.port), action.options.mode + '')
				})
			},
		},
		ProfilePOEMode: {
			name: 'Profile: Set POE Mode',
			options: [
				{
					type: 'dropdown',
					label: 'Profile Name',
					id: 'profile',
					default: '',
					allowCustom: true,
					choices: self.portProfileOptions,
				},
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: [
						{ id: 'auto', label: 'Auto' },
						{ id: 'pasv24', label: '24V Passive' },
						{ id: 'off', label: 'Off' },
					],
					default: 'auto',
				},
			],
			callback: async (action) => {
				await self.queue.add(async () => {
					await self.changePortProfilePOEMode(action.options.profile + '', action.options.mode + '')
				})
			},
		},
		updateWifiNetwork: {
			name: 'WiFi: Update Network',
			options: [
				{
					type: 'dropdown',
					label: 'WiFi Network',
					id: 'wifiNetwork',
					default: '',
					allowCustom: false,
					choices: self.wifiNetworkOptions,
				},
				{
					type: 'dropdown',
					label: 'Action',
					id: 'action',
					choices: [
						{ id: 'changeSSID', label: 'Change SSID' },
						{ id: 'changePassword', label: 'Change Password' },
						{ id: 'changeState', label: 'Enable/Disable' },
						{ id: 'deleteNetwork', label: 'Delete' },
					],
					default: 'changeSSID',
				},
				{
					type: 'textinput',
					label: 'New SSID',
					id: 'newSsid',
					default: '', // in future we might want to show current SSID according to selected network
					useVariables: true,
					tooltip: 'The new SSID for the WiFi network',
					regex: '^.{1,}$',
					isVisibleExpression: '$(options:action) == "changeSSID"',
				},
				{
					type: 'textinput',
					label: 'New Password',
					id: 'newPassword',
					default: '', // in future we might want to show current password according to selected network
					useVariables: true,
					tooltip: 'Password must be at least 8 characters long',
					regex: '^.{8,}$',
					isVisibleExpression: '$(options:action) == "changePassword"',
				},
				{
					type: 'dropdown',
					label: 'State',
					id: 'state',
					choices: [
						{ id: 'true', label: 'Enable' },
						{ id: 'false', label: 'Disable' },
					],
					default: 'true', // in future we might want to show current state according to selected network
					isVisibleExpression: '$(options:action) == "changeState"',
				},
			],
			callback: async (action) => {
				await self.queue.add(async () => {
					//self.log('debug', `Executing updateWifiNetwork action`)
					//self.log('debug', `Action Options: ${JSON.stringify(action.options)}`)
					let payload = {}
					switch (action.options.action) {
						case 'changeSSID':
							const newSsid = await self.parseVariablesInString(action.options.newSsid + '')
							if (newSsid.length == 0) {
								self.log('error', `SSID cannot be empty`)
								return
							}
							self.log('debug', `Updating SSID to: ${newSsid}`)
							payload = { name: newSsid }
							await self.updateWifiNetwork(action.options.wifiNetwork + '', payload)
							await self.refreshActionInfo().catch(() => null)
							// in future we might want to update action options too
							break
						case 'changePassword':
							const newPassword = await self.parseVariablesInString(action.options.newPassword + '')
							if (newPassword.length < 8) {
								self.log('error', `Password must be at least 8 characters long`)
								return
							}
							self.log('debug', `Changing password to: ${newPassword}`)
							payload = { x_passphrase: newPassword }
							await self.updateWifiNetwork(action.options.wifiNetwork + '', payload)
							break
						case 'changeState':
							const enable = action.options.state + '' === 'true'
							self.log('debug', `${enable ? 'Enable' : 'Disable'} WiFi Network ${action.options.wifiNetwork}`)
							payload = { enabled: enable }
							await self.updateWifiNetwork(action.options.wifiNetwork + '', payload)
							break
						case 'deleteNetwork':
							self.log('debug', `Deleting WiFi Network ${action.options.wifiNetwork}`)
							await self.deleteWLan(action.options.wifiNetwork + '')
							await self.refreshActionInfo().catch(() => null)
							break
						default:
							self.log('error', `Unknown action: ${action.options.action}`)
					}
				})
			},
		},
	}
}
