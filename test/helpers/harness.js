import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getFeedbackDefinitions } from '../../feedbacks.js'
import { getVariableDefinitions } from '../../variables.js'

export async function flush() {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}
export function deferred() {
	let resolve
	const promise = new Promise((ok) => {
		resolve = ok
	})
	return { promise, resolve }
}
export const LOOP_DELAYS = new Set([0, 10000, 20000, 40000, 60000])

/**
 * Loads main.js outside Companion with an injected base class and UniFi library.
 * Timers are fake by default; pass realTimers to drive a real node-unifi Controller.
 */
export function createHarness(controllers, { unifi, realTimers = false } = {}) {
	const timers = []
	const logs = []
	const created = []
	const helper = readFileSync(new URL('../../connection.js', import.meta.url), 'utf8').replace(/^export /gm, '')
	const source = readFileSync(new URL('../../main.js', import.meta.url), 'utf8')
		.replace(/^import .*$/gm, '')
		.replace('export class', 'class')
		.replace(/^runEntrypoint\(.*$/gm, '')
	class Base {
		statuses = []
		updateStatus(status) {
			this.statuses.push(status)
		}
		variables = {}
		variableDefinitions = []
		feedbackDefinitions = {}
		feedbackChecks = []
		setActionDefinitions() {}
		setVariableDefinitions(defs) {
			this.variableDefinitions = defs
		}
		setVariableValues(values) {
			Object.assign(this.variables, values)
		}
		setFeedbackDefinitions(defs) {
			this.feedbackDefinitions = defs
		}
		checkFeedbacks(...ids) {
			this.feedbackChecks.push(...ids)
		}
		/** Evaluates a feedback the way Companion would for a button with these options. */
		feedback(id, options = {}) {
			return this.feedbackDefinitions[id].callback({ options })
		}
		log(level, message) {
			logs.push([level, message])
		}
	}
	const Controller = function (options) {
		const next = unifi ? new unifi.Controller(options) : controllers.shift()
		assert.ok(next, 'unexpected extra Controller construction')
		created.push(next)
		return next
	}
	const Instance = new Function(
		'InstanceBase',
		'InstanceStatus',
		'unifi',
		'pQueue',
		'getActionDefinitions',
		'getFeedbackDefinitions',
		'getVariableDefinitions',
		'getConfigFields',
		'UpgradeScripts',
		'setTimeout',
		'clearTimeout',
		helper + '\n' + source + '\nreturn UnifiInstance',
	)(
		Base,
		{ Ok: 'ok', Connecting: 'connecting', ConnectionFailure: 'failed' },
		{ Controller },
		class {},
		() => ({}),
		getFeedbackDefinitions,
		getVariableDefinitions,
		() => [],
		[],
		realTimers
			? setTimeout
			: (callback, delay) => {
					const timer = { callback, delay }
					timers.push(timer)
					return timer
				},
		realTimers
			? clearTimeout
			: (timer) => {
					const i = timers.indexOf(timer)
					if (i >= 0) timers.splice(i, 1)
				},
	)
	return {
		instance: new Instance(),
		timers,
		logs,
		created,
		async fireLoopTimer() {
			const timer = timers.find((t) => LOOP_DELAYS.has(t.delay))
			assert.ok(timer, 'no pending loop timer')
			timers.splice(timers.indexOf(timer), 1)
			await timer.callback()
			await flush()
		},
	}
}
