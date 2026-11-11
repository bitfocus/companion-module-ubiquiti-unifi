import type { CompanionOptionValues } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type FeedbacksSchema = {
	deviceOnline: { type: 'boolean'; options: { deviceId: string } }
	// portIdx__<deviceId> is a dynamic field generated per switch, see main.ts getSwitchAndPortFields.
	portPoePowered: { type: 'boolean'; options: CompanionOptionValues }
	clientOnline: { type: 'boolean'; options: { macAddress: string } }
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		deviceOnline: {
			type: 'boolean',
			name: 'Device online',
			description: 'Active while the selected UniFi device is online',
			defaultStyle: { bgcolor: 0x00c800, color: 0xffffff },
			options: [
				{
					type: 'dropdown',
					id: 'deviceId',
					label: 'Device',
					choices: self.getDeviceChoices(),
					default: self.getDeviceChoices()[0]?.id ?? '',
				},
			],
			callback: (feedback) => {
				const deviceId = String(feedback.options.deviceId ?? '')
				return self.devices.find((device) => device.id === deviceId)?.state === 'ONLINE'
			},
		},
		portPoePowered: {
			type: 'boolean',
			name: 'Switchport: PoE delivering power',
			description: 'Active while the selected port is currently delivering PoE power',
			defaultStyle: { bgcolor: 0x00c800, color: 0xffffff },
			options: self.getSwitchAndPortFields(),
			callback: (feedback) => {
				const selection = self.getPortSelection(feedback.options)
				if (!selection) return false
				const port = self.deviceDetails.get(selection.deviceId)?.ports?.find((p) => p.idx === selection.portIdx)
				return port?.poe?.state === 'UP'
			},
		},
		clientOnline: {
			type: 'boolean',
			name: 'Network client online',
			description:
				'Active while the selected client (computer, phone, AV device, ...) is connected to the network. ' +
				'Only lists clients the module has seen connected at least once.',
			defaultStyle: { bgcolor: 0x00c800, color: 0xffffff },
			options: [
				{
					type: 'dropdown',
					id: 'macAddress',
					label: 'Client',
					choices: self.getClientChoices(),
					default: self.getClientChoices()[0]?.id ?? '',
					minChoicesForSearch: 1,
				},
			],
			callback: (feedback) => {
				const macAddress = typeof feedback.options.macAddress === 'string' ? feedback.options.macAddress : ''
				return self.isClientOnline(macAddress)
			},
		},
	})
}
