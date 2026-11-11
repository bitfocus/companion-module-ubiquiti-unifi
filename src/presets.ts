import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const restartIds: string[] = []
	const powerCycleIds: string[] = []
	const warningIds: string[] = []

	for (const device of self.devices) {
		const id = `restart_${device.id}`
		restartIds.push(id)
		presets[id] = {
			type: 'simple',
			name: `Restart: ${device.name}`,
			style: {
				text: `Restart\\n${device.name}`,
				size: 'auto',
				color: 0xffffff,
				bgcolor: 0x000000,
				alignment: 'center:center',
			},
			steps: [{ down: [{ actionId: 'restartDevice', options: { deviceId: device.id } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'deviceOnline',
					options: { deviceId: device.id },
					style: { bgcolor: 0x00c800 },
				},
			],
		}
	}

	for (const [deviceId, detail] of self.deviceDetails) {
		for (const port of detail.ports ?? []) {
			if (!port.poe) continue
			const id = `poeCycle_${deviceId}_${port.idx}`
			powerCycleIds.push(id)
			presets[id] = {
				type: 'simple',
				name: `PoE power cycle: ${detail.name} port ${port.idx}`,
				style: {
					text: `${detail.name}\\nPort ${port.idx}`,
					size: 'auto',
					color: 0xffffff,
					bgcolor: 0x000000,
					alignment: 'center:center',
				},
				steps: [
					{
						down: [{ actionId: 'powerCyclePort', options: { deviceId, [self.portFieldId(deviceId)]: port.idx } }],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'portPoePowered',
						options: { deviceId, [self.portFieldId(deviceId)]: port.idx },
						style: { bgcolor: 0x00c800 },
					},
				],
			}
		}
	}

	for (const device of self.devices) {
		const id = `deviceOfflineWarning_${device.id}`
		warningIds.push(id)
		presets[id] = {
			type: 'simple',
			name: `Warning: ${device.name} offline`,
			style: {
				text: `⚠ ${device.name}\\nOFFLINE`,
				size: 'auto',
				color: 0xffffff,
				bgcolor: 0x000000,
				alignment: 'center:center',
			},
			steps: [{ down: [], up: [] }],
			feedbacks: [
				{
					feedbackId: 'deviceOnline',
					options: { deviceId: device.id },
					style: { bgcolor: 0xc80000 },
					isInverted: true,
				},
			],
		}
	}

	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{ id: 'restart', name: 'Restart', definitions: restartIds },
		{ id: 'poeCycle', name: 'PoE power cycle', definitions: powerCycleIds },
		{ id: 'warnings', name: 'Warnings', definitions: warningIds },
	]

	self.setPresetDefinitions(structure, presets)
}
