// @ts-check

/**
 * @param {import("./main.js").UnifiInstance} self
 * @returns {import("@companion-module/base").CompanionActionDefinitions}
 */
export function getActionDefinitions(self) {
	return {
		POECycle: {
			name: 'Power Cycle POE Switchport',
			options: [
				{
					type: 'textinput',
					label: 'Site',
					id: 'site',
					default: 'default',
				},
				{
					type: 'textinput',
					label: 'Switch Mac Address',
					id: 'mac',
					default: '',
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
					await self.doPowerCyclePort(action.options.site + '', action.options.mac + '', Number(action.options.port))
				})
			},
		},
		POEMode: {
			name: 'Switchport POE Mode',
			options: [
				{
					type: 'textinput',
					label: 'Site',
					id: 'site',
					default: 'default',
				},
				{
					type: 'textinput',
					label: 'Switch Mac Address',
					id: 'mac',
					default: '',
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
					await self.changePortPOEMode(
						action.options.site + '',
						action.options.mac + '',
						Number(action.options.port),
						action.options.mode + ''
					)
				})
			},
		},
		ProfilePOEMode: {
			name: 'Profile POE Mode',
			options: [
				{
					type: 'textinput',
					label: 'Site',
					id: 'site',
					default: 'default',
				},
				{
					type: 'textinput',
					label: 'Profile Name',
					id: 'profile',
					default: '',
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
					await self.changePortProfilePOEMode(
						action.options.site + '',
						action.options.profile + '',
						action.options.mode + ''
					)
				})
			},
		},
	}
}
