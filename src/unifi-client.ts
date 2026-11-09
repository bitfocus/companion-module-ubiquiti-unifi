import { Agent } from 'undici'

const REQUEST_TIMEOUT_MS = 8000
const PAGE_LIMIT = 100
const MAX_PAGES = 20

// UniFi-OS consoles serve the Integration API behind a self-signed local certificate by default, so
// certificate verification is opt-in. Both agents are scoped to UniFi calls only, never applied globally.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })
const verifyingAgent = new Agent()

export function dispatcherFor(verifyTls: boolean): Agent {
	return verifyTls ? verifyingAgent : insecureAgent
}

export type UnifiClientConfig = {
	host: string
	port: number
	siteId: string
	apiKey: string
	verifyTls: boolean
}

export type UnifiSite = {
	id: string
	internalReference: string
	name: string
}

export type UnifiPoeInfo = {
	standard?: string
	type?: number
	enabled: boolean
	state: 'UP' | 'DOWN' | string
}

export type UnifiPort = {
	idx: number
	state: 'UP' | 'DOWN' | string
	connector?: string
	maxSpeedMbps?: number
	speedMbps?: number
	poe?: UnifiPoeInfo
}

export type UnifiDevice = {
	id: string
	macAddress: string
	ipAddress?: string
	name: string
	model: string
	state: 'ONLINE' | 'OFFLINE' | string
	firmwareVersion?: string
	features: string[]
	interfaces: string[]
}

export type UnifiDeviceDetail = UnifiDevice & {
	ports?: UnifiPort[]
}

export type UnifiClient = {
	id: string
	type: 'WIRED' | 'WIRELESS' | string
	name: string
	ipAddress?: string
	/** Missing for VPN/Teleport clients. */
	macAddress?: string
	uplinkDeviceId?: string
}

export type UnifiResult<T> =
	| { outcome: 'ok'; data: T }
	| { outcome: 'unauthorized' }
	| { outcome: 'not-found' }
	| { outcome: 'timeout' }
	| { outcome: 'error'; message: string }

function baseUrl(config: UnifiClientConfig): string {
	return `https://${config.host}:${config.port}/proxy/network/integration/v1`
}

const MAX_ERROR_DETAIL_LENGTH = 200

/**
 * Builds a short, log-safe error message from an HTTP error response. Uses the `message` field of a JSON
 * error body if present, otherwise only the status code (HTML error pages are not copied into logs).
 */
export function httpErrorMessage(status: number, body: string): string {
	let detail = ''
	let requestId = ''
	try {
		const parsed = JSON.parse(body) as { message?: unknown; meta?: { msg?: unknown }; requestId?: unknown }
		const candidate = parsed.message ?? parsed.meta?.msg
		if (typeof candidate === 'string') detail = candidate
		// For HTTP 500 the console logs the error under this ID, so it is needed for any further analysis.
		if (typeof parsed.requestId === 'string' && /^[0-9a-f-]{8,64}$/i.test(parsed.requestId)) {
			requestId = parsed.requestId
		}
	} catch {
		// not JSON
	}
	// eslint-disable-next-line no-control-regex
	detail = detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
	if (detail.length > MAX_ERROR_DETAIL_LENGTH) detail = `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
	return `HTTP ${status}${detail ? `: ${detail}` : ''}${requestId ? ` (requestId ${requestId})` : ''}`
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError') return 'Timeout while connecting to the UniFi console'
		return err.message
	}
	return String(err)
}

async function request<T>(config: UnifiClientConfig, path: string): Promise<UnifiResult<T>> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(`${baseUrl(config)}${path}`, {
			method: 'GET',
			headers: { 'X-API-KEY': config.apiKey, Accept: 'application/json' },
			signal: controller.signal,
			dispatcher: dispatcherFor(config.verifyTls),
		} as unknown as RequestInit)

		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (response.status === 404) return { outcome: 'not-found' }
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			return { outcome: 'error', message: httpErrorMessage(response.status, body) }
		}

		const data = (await response.json()) as T
		return { outcome: 'ok', data }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	} finally {
		clearTimeout(timeout)
	}
}

async function requestAction(config: UnifiClientConfig, path: string, action: string): Promise<UnifiResult<void>> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(`${baseUrl(config)}${path}`, {
			method: 'POST',
			headers: {
				'X-API-KEY': config.apiKey,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ action }),
			signal: controller.signal,
			dispatcher: dispatcherFor(config.verifyTls),
		} as unknown as RequestInit)

		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (response.status === 404) return { outcome: 'not-found' }
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			return { outcome: 'error', message: httpErrorMessage(response.status, body) }
		}
		return { outcome: 'ok', data: undefined }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	} finally {
		clearTimeout(timeout)
	}
}

type PagedResponse<T> = {
	offset: number
	limit: number
	count: number
	totalCount: number
	data: T[]
}

async function requestAllPages<T>(config: UnifiClientConfig, path: string): Promise<UnifiResult<T[]>> {
	const separator = path.includes('?') ? '&' : '?'
	const items: T[] = []
	let offset = 0
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await request<PagedResponse<T>>(config, `${path}${separator}limit=${PAGE_LIMIT}&offset=${offset}`)
		if (result.outcome !== 'ok') return result
		const pageItems = result.data.data ?? []
		items.push(...pageItems)
		// Advance by what was actually returned, a short page must not skip items.
		offset += pageItems.length
		if (pageItems.length === 0 || offset >= result.data.totalCount) return { outcome: 'ok', data: items }
	}
	// Returning truncated data would e.g. mark missing clients as offline.
	return { outcome: 'error', message: `More than ${MAX_PAGES * PAGE_LIMIT} entries for ${path}` }
}

export async function getApplicationInfo(
	config: UnifiClientConfig,
): Promise<UnifiResult<{ applicationVersion: string }>> {
	return request(config, '/info')
}

export async function listSites(config: UnifiClientConfig): Promise<UnifiResult<UnifiSite[]>> {
	return requestAllPages(config, '/sites')
}

export async function listDevices(config: UnifiClientConfig): Promise<UnifiResult<UnifiDevice[]>> {
	return requestAllPages(config, `/sites/${config.siteId}/devices`)
}

/**
 * Returns all clients currently connected to the network (computers, phones, AV devices, ...).
 * Unlike devices there is no explicit "state" field: a client that is not connected (anymore) is simply
 * missing from the list instead of being marked "OFFLINE".
 */
export async function listClients(config: UnifiClientConfig): Promise<UnifiResult<UnifiClient[]>> {
	return requestAllPages(config, `/sites/${config.siteId}/clients`)
}

export async function getDevice(config: UnifiClientConfig, deviceId: string): Promise<UnifiResult<UnifiDeviceDetail>> {
	const result = await request<Record<string, unknown>>(config, `/sites/${config.siteId}/devices/${deviceId}`)
	if (result.outcome !== 'ok') return result
	const raw = result.data
	const interfaces = raw.interfaces as { ports?: UnifiPort[] } | undefined
	return {
		outcome: 'ok',
		data: {
			...(raw as unknown as UnifiDevice),
			ports: interfaces?.ports ?? [],
		},
	}
}

export async function restartDevice(config: UnifiClientConfig, deviceId: string): Promise<UnifiResult<void>> {
	return requestAction(config, `/sites/${config.siteId}/devices/${deviceId}/actions`, 'RESTART')
}

export async function powerCyclePort(
	config: UnifiClientConfig,
	deviceId: string,
	portIdx: number,
): Promise<UnifiResult<void>> {
	return requestAction(
		config,
		`/sites/${config.siteId}/devices/${deviceId}/interfaces/ports/${portIdx}/actions`,
		'POWER_CYCLE',
	)
}
