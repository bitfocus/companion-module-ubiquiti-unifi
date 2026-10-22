// @ts-check

/**
 * @returns {import("@companion-module/base").CompanionVariableDefinition[]}
 */
export function getVariableDefinitions() {
	return [
		{ variableId: 'connection_status', name: 'Controller connection status (ok, connecting, failed)' },
		{ variableId: 'last_error', name: 'Last connection error' },
		{ variableId: 'last_connected', name: 'Time the controller connection was last established' },
		{ variableId: 'reconnect_count', name: 'Automatic reconnections since the connection was configured' },
		{ variableId: 'last_action', name: 'Last action run' },
		{ variableId: 'last_action_result', name: 'Result of the last action (ok, or failed: reason)' },
		{ variableId: 'last_action_time', name: 'Time the last action finished' },
	]
}
