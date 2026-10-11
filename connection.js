// Each configured controller owns its own loop. Stopping invalidates in-flight work.
//
// Recovery always builds a brand-new session via connect(): node-unifi's login() is a
// no-op once a Controller has initialised, so an expired session on an existing
// Controller can never be renewed. A fresh session is what a module restart did.
export function startConnectionLoop({
	connect,
	check,
	refresh,
	dispose = () => {},
	onConnecting,
	onConnected,
	onFailure,
	interval = 10000,
	maxRetryDelay = 60000,
	timeout = 30000,
	schedule = setTimeout,
	cancel = clearTimeout,
}) {
	let stopped = false
	let running = false
	let timer
	let session
	// True once the current session has passed a check; actions need not wait on routine checks.
	let healthy = false
	let retryDelay = interval
	let waiters = []
	const isCurrent = () => !stopped

	function settleWaiters(error) {
		const pending = waiters
		waiters = []
		for (const waiter of pending) {
			cancel(waiter.timer)
			if (error) waiter.reject(error)
			else waiter.resolve(session)
		}
	}

	function safeDispose(old) {
		try {
			dispose(old)
		} catch {
			// Disposal is best-effort; a broken session must never stop recovery.
		}
	}

	function dropSession() {
		const old = session
		session = undefined
		healthy = false
		if (old !== undefined) safeDispose(old)
	}

	async function tick() {
		if (stopped || running) return
		running = true
		cancel(timer)
		timer = undefined
		let nextDelay = interval
		try {
			const recovering = session === undefined
			if (recovering) {
				onConnecting()
				const connecting = connect()
				let fresh
				try {
					fresh = await withTimeout(connecting, timeout, 'Login')
				} catch (error) {
					// A login that finishes after we gave up must not leak its sockets.
					connecting.then(safeDispose, () => null)
					throw error
				}
				if (stopped) {
					safeDispose(fresh)
					return
				}
				session = fresh
			}
			const current = session
			// Read a real Network API endpoint, including authentication and site access.
			await withTimeout(check(current), timeout, 'Connection check')
			if (stopped) return
			if (session !== current) {
				// reconnect() discarded this session mid-check; build a fresh one right away.
				nextDelay = 0
				return
			}
			retryDelay = interval
			healthy = true
			onConnected(current)
			settleWaiters()
			if (recovering) {
				try {
					await refresh(current, isCurrent)
				} catch {
					// Dropdown refresh is cosmetic; it must never tear down a working session.
				}
			}
		} catch (error) {
			if (stopped) return
			dropSession()
			onFailure(error)
			settleWaiters(error)
			nextDelay = retryDelay
			retryDelay = Math.min(retryDelay * 2, maxRetryDelay)
		} finally {
			running = false
			if (!stopped) timer = schedule(tick, nextDelay)
		}
	}

	void tick()
	return {
		isCurrent,
		/** Discard the current session (e.g. an action saw 401) and reconnect now. */
		reconnect() {
			if (stopped) return
			if (!running) {
				dropSession()
				void tick()
			} else if (session !== undefined) {
				// A check is in flight on a session we now know is bad; it will be replaced next tick.
				dropSession()
			}
		},
		/** Resolves with a connected session, kicking an immediate attempt if disconnected. */
		whenConnected(waitMs) {
			if (stopped) return Promise.reject(new Error('Connection stopped'))
			if (healthy) return Promise.resolve(session)
			return new Promise((resolve, reject) => {
				const waiter = { resolve, reject, timer: undefined }
				waiter.timer = schedule(() => {
					waiters = waiters.filter((w) => w !== waiter)
					reject(new Error('Not connected to the UniFi controller'))
				}, waitMs)
				waiters.push(waiter)
				if (!running) void tick()
			})
		},
		stop() {
			stopped = true
			cancel(timer)
			settleWaiters(new Error('Connection stopped'))
			dropSession()
		},
	}
}

/**
 * Guarantees a pending request cannot wedge the loop or the action queue.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
	let timer
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
			timer.unref?.()
		}),
	]).finally(() => clearTimeout(timer))
}

/**
 * True when the controller rejected the request for authentication/CSRF reasons, i.e. it was not applied.
 * @param {any} error
 */
export function isAuthError(error) {
	const status = error?.response?.status
	if (status === 401 || status === 403) return true
	return /LoginRequired|status code 40[13]/.test(String(error?.message ?? error))
}
