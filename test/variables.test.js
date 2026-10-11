import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, flush } from './helpers/harness.js'

function controller(overrides = {}) {
	return {
		_isInit: false,
		login: async function () {
			this._isInit = true
		},
		logout: async () => {},
		removeAllListeners() {},
		getPortConfig: async () => [],
		getAccessDevicesBasic: async () => [],
		powerCycleSwitchPort: async () => {},
		...overrides,
	}
}
const offline = () =>
	controller({
		login: async () => {
			throw new Error('EHOSTUNREACH')
		},
	})

test('every defined variable has a value once connected', async () => {
	const { instance } = createHarness([controller()])
	await instance.init({})
	await flush()
	const ids = instance.variableDefinitions.map((v) => v.variableId)
	assert.deepEqual(ids, [
		'connection_status',
		'last_error',
		'last_connected',
		'reconnect_count',
		'last_action',
		'last_action_result',
		'last_action_time',
	])
	for (const id of ids) assert.notEqual(instance.variables[id], undefined, `${id} has no value`)
	assert.equal(instance.variables.connection_status, 'ok')
	assert.match(instance.variables.last_connected, /\d{1,2}:\d{2}:\d{2}/)
	assert.equal(instance.variables.reconnect_count, 0)
	await instance.destroy()
})

test('connection failure and recovery update status, error, reconnect count and feedback', async () => {
	let expired = false
	const { instance, fireLoopTimer } = createHarness([
		controller({
			getAccessDevicesBasic: async () => {
				if (expired) throw new Error('Request failed with status code 401')
				return []
			},
		}),
		controller(),
	])
	await instance.init({})
	await flush()
	assert.equal(instance.feedback('connectionState', { state: 'ok' }), true)
	assert.equal(instance.feedback('connectionState', { state: 'failed' }), false)

	expired = true
	await fireLoopTimer()
	assert.equal(instance.variables.connection_status, 'failed')
	assert.match(instance.variables.last_error, /401/)
	assert.equal(instance.feedback('connectionState', { state: 'failed' }), true)
	assert.ok(instance.feedbackChecks.includes('connectionState'))

	await fireLoopTimer()
	assert.equal(instance.variables.connection_status, 'ok')
	assert.equal(instance.variables.reconnect_count, 1)
	assert.equal(instance.feedback('connectionState', { state: 'ok' }), true)
	await instance.destroy()
})

test('failed first connection is not counted as a reconnect', async () => {
	const { instance, fireLoopTimer } = createHarness([offline(), offline(), controller()])
	await instance.init({})
	await flush()
	assert.equal(instance.variables.connection_status, 'failed')
	assert.equal(instance.variables.last_connected, '')
	const changes = instance.feedbackChecks.length
	await fireLoopTimer()
	assert.equal(instance.variables.connection_status, 'failed')
	assert.equal(instance.feedbackChecks.length, changes, 'status must not flicker to connecting during retries')
	await fireLoopTimer()
	assert.equal(instance.variables.connection_status, 'ok')
	assert.equal(instance.variables.reconnect_count, 0)
	await instance.destroy()
})

test('action results are recorded and drive the last-action-failed feedback', async () => {
	let fail = true
	const { instance } = createHarness([
		controller({
			powerCycleSwitchPort: async () => {
				if (fail) throw new Error('api.err.InvalidTargetPort')
			},
		}),
	])
	await instance.init({})
	await flush()
	assert.equal(instance.feedback('lastActionFailed'), false)

	await instance.doPowerCyclePort('aa:bb', 7)
	assert.equal(instance.variables.last_action, 'Power cycle port aa:bb@7')
	assert.equal(instance.variables.last_action_result, 'failed: api.err.InvalidTargetPort')
	assert.match(instance.variables.last_action_time, /\d{1,2}:\d{2}:\d{2}/)
	assert.equal(instance.feedback('lastActionFailed'), true)

	fail = false
	await instance.doPowerCyclePort('aa:bb', 7)
	assert.equal(instance.variables.last_action_result, 'ok')
	assert.equal(instance.feedback('lastActionFailed'), false)
	await instance.destroy()
})

test('an action retried after a stale session is recorded as ok', async () => {
	const unauthorized = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } })
	const { instance } = createHarness([
		controller({
			powerCycleSwitchPort: async () => {
				throw unauthorized
			},
		}),
		controller(),
	])
	await instance.init({})
	await flush()
	await instance.doPowerCyclePort('aa:bb', 1)
	assert.equal(instance.variables.last_action_result, 'ok')
	assert.equal(instance.variables.reconnect_count, 1)
	await instance.destroy()
})

test('changing the connection config resets the reconnect count and error', async () => {
	let expired = false
	const { instance, fireLoopTimer } = createHarness([
		controller({
			getAccessDevicesBasic: async () => {
				if (expired) throw new Error('boom')
				return []
			},
		}),
		controller(),
		controller(),
	])
	await instance.init({})
	await flush()
	expired = true
	await fireLoopTimer()
	await fireLoopTimer()
	assert.equal(instance.variables.reconnect_count, 1)
	await instance.configUpdated({ host: 'other' })
	await flush()
	assert.equal(instance.variables.reconnect_count, 0)
	assert.equal(instance.variables.last_error, '')
	assert.equal(instance.variables.connection_status, 'ok')
	await instance.destroy()
})
