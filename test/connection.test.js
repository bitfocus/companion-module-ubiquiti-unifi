import test from 'node:test'
import assert from 'node:assert/strict'
import { startConnectionLoop, withTimeout, isAuthError } from '../connection.js'

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function deferred() {
	let resolve, reject
	const promise = new Promise((ok, fail) => {
		resolve = ok
		reject = fail
	})
	return { promise, resolve, reject }
}

function harness(overrides = {}) {
	const events = [],
		timers = [],
		sessions = [],
		disposed = []
	let checks = 0,
		refreshes = 0
	const loop = startConnectionLoop({
		connect: async () => {
			const s = { id: sessions.length + 1 }
			sessions.push(s)
			return s
		},
		check: async () => {
			checks++
		},
		refresh: async () => {
			refreshes++
		},
		dispose: (s) => disposed.push(s.id),
		onConnecting: () => events.push('connecting'),
		onConnected: () => events.push('connected'),
		onFailure: () => events.push('failed'),
		schedule: (callback, delay) => {
			const timer = { callback, delay }
			timers.push(timer)
			return timer
		},
		cancel: (timer) => {
			const i = timers.indexOf(timer)
			if (i >= 0) timers.splice(i, 1)
		},
		...overrides,
	})
	return {
		loop,
		events,
		timers,
		sessions,
		disposed,
		get logins() {
			return sessions.length
		},
		get checks() {
			return checks
		},
		get refreshes() {
			return refreshes
		},
		async advance() {
			const timer = timers.find((t) => t.delay !== 15000)
			timers.splice(timers.indexOf(timer), 1)
			await timer.callback()
			await flush()
		},
	}
}

test('healthy connection performs real reads without repeated login or refresh', async () => {
	const h = harness()
	await flush()
	assert.equal(h.logins, 1)
	assert.equal(h.checks, 1)
	assert.equal(h.refreshes, 1)
	assert.equal(h.timers[0].delay, 10000)
	await h.advance()
	assert.equal(h.logins, 1)
	assert.equal(h.checks, 2)
	assert.equal(h.refreshes, 1)
	h.loop.stop()
})

test('failed initial login retries with capped backoff and recovers', async () => {
	let offline = true,
		attempts = 0
	const h = harness({
		connect: async () => {
			attempts++
			if (offline) throw new Error('offline')
			return {}
		},
	})
	await flush()
	for (const delay of [10000, 20000, 40000, 60000, 60000]) {
		assert.equal(h.timers[0].delay, delay)
		await h.advance()
	}
	offline = false
	await h.advance()
	assert.equal(h.events.at(-1), 'connected')
	assert.equal(h.refreshes, 1)
	assert.equal(h.timers[0].delay, 10000)
	assert.equal(attempts, 7)
	h.loop.stop()
})

test('expired session is discarded and recovery uses a brand-new session', async () => {
	const expired = new Set()
	const checked = []
	const h = harness({
		check: async (s) => {
			checked.push(s.id)
			if (expired.has(s.id)) throw new Error('401')
		},
	})
	await flush()
	expired.add(1)
	await h.advance()
	assert.equal(h.events.at(-1), 'failed')
	assert.deepEqual(h.disposed, [1])
	await h.advance()
	assert.equal(h.logins, 2)
	assert.deepEqual(checked, [1, 1, 2])
	assert.equal(h.refreshes, 2)
	assert.equal(h.events.at(-1), 'connected')
	h.loop.stop()
	assert.deepEqual(h.disposed, [1, 2])
})

test('a failed Network read after login never reports connected', async () => {
	const h = harness({
		check: async () => {
			throw new Error('site inaccessible')
		},
	})
	await flush()
	assert.deepEqual(h.events, ['connecting', 'failed'])
	assert.equal(h.refreshes, 0)
	assert.equal(h.timers.length, 1)
	h.loop.stop()
})

test('a failing dropdown refresh does not tear down a working session', async () => {
	const h = harness({
		refresh: async () => {
			throw new Error('boom')
		},
	})
	await flush()
	assert.equal(h.events.at(-1), 'connected')
	assert.deepEqual(h.disposed, [])
	h.loop.stop()
})

test('checks cannot overlap while a read is pending', async () => {
	const read = deferred()
	const h = harness({ check: () => read.promise })
	await flush()
	assert.equal(h.timers.length, 0)
	h.loop.reconnect()
	await flush()
	assert.equal(h.logins, 1)
	read.resolve()
	await flush()
	assert.equal(h.timers.length, 1)
	h.loop.stop()
	assert.equal(h.timers.length, 0)
})

test('a hung check times out instead of stalling the loop forever', async () => {
	const h = harness({ check: () => new Promise(() => {}), timeout: 20 })
	await new Promise((r) => setTimeout(r, 40))
	await flush()
	assert.deepEqual(h.events, ['connecting', 'failed'])
	assert.equal(h.timers.length, 1)
	h.loop.stop()
})

test('a login that completes after timing out is disposed', async () => {
	const login = deferred()
	const h = harness({ connect: () => login.promise, timeout: 20 })
	await new Promise((r) => setTimeout(r, 40))
	await flush()
	assert.equal(h.events.at(-1), 'failed')
	login.resolve({ id: 'late' })
	await flush()
	assert.deepEqual(h.disposed, ['late'])
	h.loop.stop()
})

test('whenConnected resolves immediately when healthy', async () => {
	const h = harness()
	await flush()
	assert.deepEqual(await h.loop.whenConnected(15000), { id: 1 })
	h.loop.stop()
})

test('whenConnected kicks an immediate attempt instead of waiting for backoff', async () => {
	let offline = true
	const h = harness({
		connect: async () => {
			if (offline) throw new Error('offline')
			return { id: 'up' }
		},
	})
	await flush()
	assert.equal(h.events.at(-1), 'failed')
	offline = false
	const session = await h.loop.whenConnected(15000)
	assert.deepEqual(session, { id: 'up' })
	assert.equal(h.events.at(-1), 'connected')
	h.loop.stop()
})

test('whenConnected rejects with the real failure when the attempt fails', async () => {
	let offline = false
	const h = harness({
		connect: async () => {
			if (offline) throw new Error('host unreachable')
			return {}
		},
	})
	await flush()
	offline = true
	h.loop.reconnect()
	await flush()
	await assert.rejects(h.loop.whenConnected(15000), /host unreachable/)
	h.loop.stop()
})

test('whenConnected times out and stop rejects pending waiters', async () => {
	const login = deferred()
	const h = harness({ connect: () => login.promise })
	await flush()
	const waiting = h.loop.whenConnected(15000)
	const waitTimer = h.timers.find((t) => t.delay === 15000)
	waitTimer.callback()
	await assert.rejects(waiting, /Not connected/)
	const second = h.loop.whenConnected(15000)
	h.loop.stop()
	await assert.rejects(second, /stopped/)
})

test('reconnect during an in-flight check builds a fresh session instead of trusting the old one', async () => {
	let read
	const h = harness({
		check: (s) => {
			if (s.id === 1 && read) return read.promise
		},
	})
	await flush()
	read = deferred()
	const t = h.timers.shift()
	const tick = t.callback()
	await flush()
	h.loop.reconnect()
	read.resolve()
	await tick
	await flush()
	assert.deepEqual(h.disposed, [1])
	assert.equal(h.timers[0].delay, 0)
	await h.advance()
	assert.equal(h.logins, 2)
	assert.deepEqual(await h.loop.whenConnected(15000), { id: 2 })
	h.loop.stop()
})

test('stopping during login prevents reads, status updates and rescheduling', async () => {
	const login = deferred()
	const h = harness({ connect: () => login.promise })
	await flush()
	h.loop.stop()
	login.resolve({ id: 'late' })
	await flush()
	assert.equal(h.checks, 0)
	assert.deepEqual(h.events, ['connecting'])
	assert.equal(h.timers.length, 0)
	assert.deepEqual(h.disposed, ['late'])
})

test('stopping during a failing check suppresses stale failure callbacks', async () => {
	const read = deferred()
	const h = harness({ check: () => read.promise })
	await flush()
	h.loop.stop()
	read.reject(new Error('old controller'))
	await flush()
	assert.deepEqual(h.events, ['connecting'])
	assert.equal(h.timers.length, 0)
})

test('refresh receives an invalidated guard when its controller is replaced', async () => {
	const pending = deferred()
	let current
	const h = harness({
		refresh: async (_s, isCurrent) => {
			current = isCurrent
			await pending.promise
		},
	})
	await flush()
	assert.equal(current(), true)
	h.loop.stop()
	assert.equal(current(), false)
	pending.resolve()
	await flush()
	assert.equal(h.timers.length, 0)
})

test('withTimeout and isAuthError helpers', async () => {
	assert.equal(await withTimeout(Promise.resolve(1), 50, 'x'), 1)
	const keepAlive = setTimeout(() => {}, 1000)
	await assert.rejects(withTimeout(new Promise(() => {}), 10, 'Thing'), /Thing timed out/)
	clearTimeout(keepAlive)
	assert.equal(isAuthError({ response: { status: 401 } }), true)
	assert.equal(isAuthError({ response: { status: 403 } }), true)
	assert.equal(isAuthError(new Error('api.err.LoginRequired')), true)
	assert.equal(isAuthError(new Error('Request failed with status code 401')), true)
	assert.equal(isAuthError(new Error('api.err.InvalidTargetPort')), false)
	assert.equal(isAuthError(new Error('timeout of 5000ms exceeded')), false)
})
