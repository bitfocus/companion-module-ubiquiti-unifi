import { dispatcherFor, httpErrorMessage } from './unifi-client.js'

// EXPERIMENTAL / LEGACY: talks to the old private UniFi-OS controller API because the
// official Integration API has no config-write endpoint for ports (verified: no
// port-profiles resource, PATCH/PUT on device and port resources both rejected).
// This is exactly the fragile API surface the rest of this module deliberately avoids —
// keep it isolated here, never call it from the main polling loop, and never trust it
// to stay stable across firmware updates. Requires a LOCAL admin account without
// 2FA/Cloud-SSO (the Ubiquiti cloud account flow does not work with this login endpoint).

const REQUEST_TIMEOUT_MS = 8000

export type UnifiLegacyConfig = {
	host: string
	port: number
	siteId: string
	username: string
	password: string
	verifyTls: boolean
}

export type UnifiLegacyResult<T> =
	| { outcome: 'ok'; data: T }
	| { outcome: 'unauthorized' }
	| { outcome: 'not-found' }
	| { outcome: 'timeout' }
	| { outcome: 'error'; message: string }

type LegacySession = {
	cookie: string
	csrfToken?: string
}

type ClassicPortOverride = {
	port_idx: number
	portconf_id?: string
	poe_mode?: string
	[key: string]: unknown
}

type ClassicDevice = {
	_id: string
	mac: string
	port_overrides?: ClassicPortOverride[]
	port_table?: Array<{ port_idx: number; portconf_id?: string }>
	[key: string]: unknown
}

type RawResponse = { status: number; ok: boolean; headers: Headers; body: string }

function baseUrl(config: UnifiLegacyConfig): string {
	return `https://${config.host}:${config.port}`
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError') return 'Timeout while connecting to the UniFi console (legacy API)'
		return err.message
	}
	return String(err)
}

function toErrorResult(err: unknown): UnifiLegacyResult<never> {
	if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
	return { outcome: 'error', message: errorMessage(err) }
}

/** Fetches a URL and reads the whole body within the same timeout (so a stalled body cannot hang forever). */
async function rawFetch(config: UnifiLegacyConfig, url: string, init: RequestInit): Promise<RawResponse> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(url, {
			...init,
			signal: controller.signal,
			dispatcher: dispatcherFor(config.verifyTls),
		} as unknown as RequestInit)
		const body = await response.text()
		return { status: response.status, ok: response.ok, headers: response.headers, body }
	} finally {
		clearTimeout(timeout)
	}
}

/** The classic API can report errors inside an HTTP 200 response (`meta.rc !== 'ok'`). */
function classicError(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { meta?: { rc?: unknown } }
		if (parsed.meta?.rc !== undefined && parsed.meta.rc !== 'ok') return httpErrorMessage(200, body)
	} catch {
		return 'Invalid response from the classic controller API'
	}
	return undefined
}

/** Some firmware versions only put the CSRF token into the payload of the `TOKEN` JWT cookie. */
function csrfFromTokenCookie(cookie: string): string | undefined {
	const token = /(?:^|;\s*)TOKEN=([^;]+)/.exec(cookie)?.[1]
	const payload = token?.split('.')[1]
	if (!payload) return undefined
	try {
		const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { csrfToken?: unknown }
		return typeof parsed.csrfToken === 'string' ? parsed.csrfToken : undefined
	} catch {
		return undefined
	}
}

/**
 * Session based client for the classic controller API. One instance per module connection:
 * - the login session is reused and renewed once when it expired (401/403)
 * - a rotated CSRF token (`x-updated-csrf-token`) is picked up from every response
 * - all writes run strictly one after another, so two PoE changes can never read the same
 *   `port_overrides` and revert each other
 */
export class UnifiLegacyClient {
	private session: LegacySession | undefined
	private queue: Promise<unknown> = Promise.resolve()

	constructor(private readonly config: UnifiLegacyConfig) {}

	/** Persistently sets a switch port's PoE mode ('auto' = PoE on, 'off' = PoE off, never passive PoE). */
	async setPortPoeMode(macAddress: string, portIdx: number, poeMode: 'auto' | 'off'): Promise<UnifiLegacyResult<void>> {
		const run = this.queue.then(async () =>
			this.withSession(async () => this.writePoeMode(macAddress, portIdx, poeMode)),
		)
		this.queue = run.catch(() => undefined)
		return run
	}

	/** Ends the session on the console (best effort). */
	async logout(): Promise<void> {
		const session = this.session
		this.session = undefined
		if (!session) return
		try {
			await rawFetch(this.config, `${baseUrl(this.config)}/api/auth/logout`, {
				method: 'POST',
				headers: this.headers(session),
			})
		} catch {
			// best effort
		}
	}

	private async withSession<T>(work: () => Promise<UnifiLegacyResult<T>>): Promise<UnifiLegacyResult<T>> {
		const hadSession = this.session !== undefined
		if (!hadSession) {
			const loginResult = await this.login()
			if (loginResult.outcome !== 'ok') return loginResult
		}

		const result = await work()
		if (result.outcome !== 'unauthorized' || !hadSession) return result

		// The reused session expired - log in once more and retry.
		this.session = undefined
		const loginResult = await this.login()
		if (loginResult.outcome !== 'ok') return loginResult
		return work()
	}

	private async login(): Promise<UnifiLegacyResult<void>> {
		try {
			const response = await rawFetch(this.config, `${baseUrl(this.config)}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({ username: this.config.username, password: this.config.password }),
			})

			if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
			if (!response.ok)
				return { outcome: 'error', message: `Login failed: ${httpErrorMessage(response.status, response.body)}` }

			const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
			if (setCookies.length === 0)
				return { outcome: 'error', message: 'Login response did not contain session cookies' }

			const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
			const csrfToken = response.headers.get('x-csrf-token') ?? csrfFromTokenCookie(cookie)
			this.session = { cookie, csrfToken }
			return { outcome: 'ok', data: undefined }
		} catch (err) {
			return toErrorResult(err)
		}
	}

	private headers(session: LegacySession, json = false): Record<string, string> {
		return {
			Cookie: session.cookie,
			Accept: 'application/json',
			...(json ? { 'Content-Type': 'application/json' } : {}),
			...(session.csrfToken ? { 'X-Csrf-Token': session.csrfToken } : {}),
		}
	}

	private async send(path: string, init: RequestInit & { json?: boolean }): Promise<RawResponse> {
		const session = this.session
		if (!session) throw new Error('Not logged in')
		const response = await rawFetch(this.config, `${baseUrl(this.config)}${path}`, {
			...init,
			headers: this.headers(session, init.json),
		})
		const updatedCsrf = response.headers.get('x-updated-csrf-token')
		if (updatedCsrf && this.session === session) session.csrfToken = updatedCsrf
		return response
	}

	private async getClassicDeviceByMac(macAddress: string): Promise<UnifiLegacyResult<ClassicDevice>> {
		try {
			const response = await this.send(
				`/proxy/network/api/s/${this.config.siteId}/stat/device/${macAddress.toLowerCase()}`,
				{ method: 'GET' },
			)
			if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
			if (response.status === 404) return { outcome: 'not-found' }
			if (!response.ok) return { outcome: 'error', message: httpErrorMessage(response.status, response.body) }
			const apiError = classicError(response.body)
			if (apiError) return { outcome: 'error', message: apiError }

			const body = JSON.parse(response.body) as { data?: ClassicDevice[] }
			const device = body.data?.[0]
			if (!device) return { outcome: 'not-found' }
			return { outcome: 'ok', data: device }
		} catch (err) {
			return toErrorResult(err)
		}
	}

	/** Merges into the existing `port_overrides` array so other ports are left untouched. */
	private async writePoeMode(
		macAddress: string,
		portIdx: number,
		poeMode: 'auto' | 'off',
	): Promise<UnifiLegacyResult<void>> {
		const deviceResult = await this.getClassicDeviceByMac(macAddress)
		if (deviceResult.outcome !== 'ok') return deviceResult
		const device = deviceResult.data

		const existingOverrides = device.port_overrides ?? []
		const existingIndex = existingOverrides.findIndex((o) => o.port_idx === portIdx)
		const existingPortConfId =
			existingOverrides[existingIndex]?.portconf_id ??
			device.port_table?.find((p) => p.port_idx === portIdx)?.portconf_id

		const nextOverrides = [...existingOverrides]
		const nextOverride: ClassicPortOverride = {
			...(existingIndex >= 0 ? existingOverrides[existingIndex] : {}),
			port_idx: portIdx,
			poe_mode: poeMode,
			...(existingPortConfId ? { portconf_id: existingPortConfId } : {}),
		}
		if (existingIndex >= 0) {
			nextOverrides[existingIndex] = nextOverride
		} else {
			nextOverrides.push(nextOverride)
		}

		try {
			const response = await this.send(`/proxy/network/api/s/${this.config.siteId}/rest/device/${device._id}`, {
				method: 'PUT',
				json: true,
				body: JSON.stringify({ port_overrides: nextOverrides }),
			})
			if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
			if (!response.ok) return { outcome: 'error', message: httpErrorMessage(response.status, response.body) }
			const apiError = classicError(response.body)
			if (apiError) return { outcome: 'error', message: apiError }
			return { outcome: 'ok', data: undefined }
		} catch (err) {
			return toErrorResult(err)
		}
	}
}
