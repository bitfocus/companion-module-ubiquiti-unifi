// @ts-check

import { combineRgb } from '@companion-module/base'

/**
 * @param {import("./main.js").UnifiInstance} self
 * @returns {import("@companion-module/base").CompanionFeedbackDefinitions}
 */
export function getFeedbackDefinitions(self) {
	return {
		connectionState: {
			type: 'boolean',
			name: 'Controller: connection state',
			description: 'Change the button style when the controller connection is in the chosen state',
			defaultStyle: {
				bgcolor: combineRgb(204, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					label: 'State',
					id: 'state',
					default: 'failed',
					choices: [
						{ id: 'ok', label: 'Connected' },
						{ id: 'connecting', label: 'Connecting' },
						{ id: 'failed', label: 'Connection failed' },
					],
				},
			],
			callback: (feedback) => self.connectionStatus === feedback.options.state,
		},
		lastActionFailed: {
			type: 'boolean',
			name: 'Last action failed',
			description: 'Change the button style when the most recent action did not succeed',
			defaultStyle: {
				bgcolor: combineRgb(255, 102, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => self.lastActionFailed,
		},
	}
}
