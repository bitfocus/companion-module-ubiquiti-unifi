import type { CompanionOptionValues } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type ActionsSchema = {
	restartDevice: { options: { deviceId: string } }
	// portIdx__<deviceId> is a dynamic field generated per switch (see main.ts getSwitchAndPortFields) -
	// the selected port is read at runtime via self.getPortSelection, not as a fixed key here.
	powerCyclePort: { options: CompanionOptionValues }
	setPortPoePersistent: { options: CompanionOptionValues }
	refreshDevices: { options: Record<string, never> }
}

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		restartDevice: {
			name: 'Restart device',
			description: 'Restarts a UniFi device (official API)',
			options: [
				{
					type: 'dropdown',
					id: 'deviceId',
					label: 'Device',
					choices: self.getDeviceChoices(),
					default: self.getDeviceChoices()[0]?.id ?? '',
				},
			],
			callback: async (action) => {
				const deviceId = typeof action.options.deviceId === 'string' ? action.options.deviceId : ''
				if (!deviceId) {
					self.log('warn', 'restartDevice: no device selected')
					return
				}
				await self.restartDevice(deviceId)
			},
		},
		powerCyclePort: {
			name: 'Switchport: PoE power cycle',
			description: 'Briefly switches a PoE port off and on again (official API)',
			options: self.getSwitchAndPortFields(),
			callback: async (action) => {
				const selection = self.getPortSelection(action.options)
				if (!selection) {
					self.log('warn', 'powerCyclePort: no valid switch/port selected')
					return
				}
				await self.powerCyclePort(selection.deviceId, selection.portIdx)
			},
		},
		// Always defined, so buttons migrated from "Set POE mode" (or copied from another setup) never show up as an
		// unknown action. While the legacy option is off the action only explains how to enable it.
		setPortPoePersistent: {
			name: self.config.enableLegacyPoeToggle
				? 'Switchport: Set PoE on/off (legacy)'
				: 'Switchport: Set PoE on/off (legacy, disabled in config)',
			description: self.config.enableLegacyPoeToggle
				? 'Switches PoE on a port on or off permanently. Uses the old, private controller API - ' +
					'may break after firmware updates, see module help.'
				: 'Requires "Enable persistent PoE on/off (legacy API)" and a local admin account in the connection ' +
					'settings. Without them the action does nothing.',
			options: [
				...self.getSwitchAndPortFields(),
				{
					type: 'checkbox',
					id: 'enabled',
					label: 'PoE enabled',
					default: true,
				},
			],
			callback: async (action) => {
				if (!self.config.enableLegacyPoeToggle) {
					self.log(
						'warn',
						'setPortPoePersistent: persistent PoE on/off is disabled. Enable "Enable persistent PoE on/off ' +
							'(legacy API)" and enter a local admin username/password in the connection settings.',
					)
					return
				}
				const selection = self.getPortSelection(action.options)
				if (!selection) {
					self.log('warn', 'setPortPoePersistent: no valid switch/port selected')
					return
				}
				await self.setPortPoePersistent(selection.deviceId, selection.portIdx, Boolean(action.options.enabled))
			},
		},
		refreshDevices: {
			name: 'Refresh device list',
			description: 'Reloads devices/ports and updates dropdown lists and presets',
			options: [],
			callback: async () => {
				await self.refreshDevices()
			},
		},
	})
}
