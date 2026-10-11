import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, deferred, flush, LOOP_DELAYS } from './helpers/harness.js'

function controller(overrides = {}) {
	const c = {
		calls: [],
		disposed: false,
		_isInit: false,
		login: async () => {
			c._isInit = true
		},
		logout: async () => {
			c.calls.push('logout')
		},
		removeAllListeners() {
			c.disposed = true
		},
		getPortConfig: async () => [{ name: 'profile' }],
		getAccessDevicesBasic: async () => [{ name: 'switch', mac: 'aa:bb:cc:dd:ee:ff' }],
		powerCycleSwitchPort: async (mac, port) => {
			c.calls.push(`cycle ${mac}@${port}`)
		},
		...overrides,
	}
	return c
}
function unauthorized() {
	return Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } })
}

test('failed startup recovers status and dropdowns', async () => {
	const { instance, fireLoopTimer, timers } = createHarness([
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
		controller(),
	])
	await instance.init({})
	await flush()
	assert.equal(instance.loggedIn, false)
	assert.equal(instance.statuses.at(-1), 'failed')
	await fireLoopTimer()
	assert.equal(instance.loggedIn, true)
	assert.equal(instance.portProfileOptions[0].id, 'profile')
	assert.equal(instance.switchMacAddressOptions[0].id, 'aa:bb:cc:dd:ee:ff')
	await instance.destroy()
	assert.equal(timers.filter((t) => LOOP_DELAYS.has(t.delay)).length, 0)
})

test('expired session is replaced by a brand-new controller, not re-used', async () => {
	let expired = false
	const first = controller({
		getAccessDevicesBasic: async () => {
			if (expired) throw unauthorized()
			return []
		},
	})
	const second = controller()
	const { instance, fireLoopTimer, created } = createHarness([first, second])
	await instance.init({})
	await flush()
	assert.equal(instance.controller, first)
	expired = true
	await fireLoopTimer()
	assert.equal(instance.statuses.at(-1), 'failed')
	assert.equal(first.disposed, true)
	assert.equal(instance.controller, undefined)
	await fireLoopTimer()
	assert.equal(created.length, 2)
	assert.equal(instance.controller, second)
	assert.equal(instance.statuses.at(-1), 'ok')
	await instance.destroy()
})

test('action rejected with 401 reconnects with a fresh controller and retries once', async () => {
	const first = controller({
		powerCycleSwitchPort: async () => {
			throw unauthorized()
		},
	})
	const second = controller()
	const { instance, logs } = createHarness([first, second])
	await instance.init({})
	await flush()
	await instance.doPowerCyclePort('aa', 3)
	assert.deepEqual(second.calls, ['cycle aa@3'])
	assert.equal(first.disposed, true)
	assert.equal(instance.controller, second)
	assert.ok(logs.some(([, m]) => /retrying once/.test(m)))
	assert.equal(
		logs.some(([l]) => l === 'error'),
		false,
	)
	await instance.destroy()
})

test('action is retried at most once and non-auth errors are not retried', async () => {
	let attempts = 0
	const { instance, logs, created } = createHarness([
		controller({
			powerCycleSwitchPort: async () => {
				attempts++
				throw new Error('api.err.InvalidTargetPort')
			},
		}),
	])
	await instance.init({})
	await flush()
	await instance.doPowerCyclePort('aa', 99)
	assert.equal(attempts, 1)
	assert.equal(created.length, 1)
	assert.ok(logs.some(([l, m]) => l === 'error' && /InvalidTargetPort/.test(m)))
	await instance.destroy()
})

test('button press while disconnected triggers an immediate reconnect and runs', async () => {
	const second = controller()
	const { instance } = createHarness([
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
		second,
	])
	await instance.init({})
	await flush()
	assert.equal(instance.statuses.at(-1), 'failed')
	await instance.doPowerCyclePort('aa', 1)
	assert.deepEqual(second.calls, ['cycle aa@1'])
	assert.equal(instance.statuses.at(-1), 'ok')
	await instance.destroy()
})

test('button press while the controller stays down fails with the real reason', async () => {
	const { instance, logs } = createHarness([
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
		controller({
			login: async () => {
				throw Error('EHOSTUNREACH')
			},
		}),
	])
	await instance.init({})
	await flush()
	await instance.doPowerCyclePort('aa', 1)
	assert.ok(logs.some(([l, m]) => l === 'error' && /EHOSTUNREACH/.test(m)))
	await instance.destroy()
})

test('repeated identical failures are logged once at warn level', async () => {
	const { instance, fireLoopTimer, logs } = createHarness([
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
		controller({
			login: async () => {
				throw Error('offline')
			},
		}),
	])
	await instance.init({})
	await flush()
	await fireLoopTimer()
	await fireLoopTimer()
	assert.equal(logs.filter(([l, m]) => l === 'warn' && /offline/.test(m)).length, 1)
	await instance.destroy()
})

test('old login cannot overwrite new connection failure', async () => {
	const oldLogin = deferred()
	const old = controller({ login: () => oldLogin.promise })
	const { instance } = createHarness([
		old,
		controller({
			login: async () => {
				throw Error('new host offline')
			},
		}),
	])
	await instance.init({})
	await instance.configUpdated({ host: 'new' })
	await flush()
	oldLogin.resolve()
	await flush()
	assert.equal(instance.loggedIn, false)
	assert.equal(instance.statuses.at(-1), 'failed')
	assert.equal(old.disposed, true)
	await instance.destroy()
})

test('old dropdown response cannot overwrite new controller lists', async () => {
	const oldProfiles = deferred()
	const { instance } = createHarness([
		controller({ getPortConfig: () => oldProfiles.promise }),
		controller({ getPortConfig: async () => [{ name: 'new profile' }] }),
	])
	await instance.init({})
	await flush()
	await instance.configUpdated({ host: 'new' })
	await flush()
	oldProfiles.resolve([{ name: 'old profile' }])
	await flush()
	assert.equal(instance.portProfileOptions[0].id, 'new profile')
	await instance.destroy()
})

test('destroy during login cannot revive the module and disposes the late session', async () => {
	const login = deferred()
	const c = controller({ login: () => login.promise })
	const { instance, timers } = createHarness([c])
	await instance.init({})
	await instance.destroy()
	login.resolve()
	await flush()
	assert.equal(instance.loggedIn, false)
	assert.equal(timers.filter((t) => LOOP_DELAYS.has(t.delay)).length, 0)
	assert.equal(instance.statuses.includes('ok'), false)
	assert.equal(c.disposed, true)
})

test('disposing a logged-in controller logs out and closes its keep-alive sockets', async () => {
	const destroyed = []
	const c = controller({
		_instance: {
			defaults: {
				httpsAgent: { destroy: () => destroyed.push('https') },
				httpAgent: { destroy: () => destroyed.push('http') },
			},
		},
	})
	const { instance } = createHarness([c])
	await instance.init({})
	await flush()
	await instance.destroy()
	await flush()
	assert.deepEqual(c.calls, ['logout'])
	assert.deepEqual(destroyed.sort(), ['http', 'https'])
})
