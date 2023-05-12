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
	}
}
