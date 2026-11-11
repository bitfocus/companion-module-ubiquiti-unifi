import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
	httpErrorMessage,
	listDevices,
	partitionValidDevices,
	type UnifiClientConfig,
	type UnifiDevice,
} from '../unifi-client.js'

const config: UnifiClientConfig = { host: 'console', port: 443, siteId: 'site', apiKey: 'key', verifyTls: false }
const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

/** Fake paged endpoint with `total` items that returns at most `serverLimit` items per page. */
function stubPagedFetch(total: number, serverLimit: number): string[] {
	const requested: string[] = []
	globalThis.fetch = async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : input)
		requested.push(url.search)
		const offset = Number(url.searchParams.get('offset'))
		const limit = Math.min(Number(url.searchParams.get('limit')), serverLimit)
		const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
			id: String(offset + i),
		}))
		return new Response(JSON.stringify({ offset, limit, count: data.length, totalCount: total, data }))
	}
	return requested
}

test('pagination collects all pages', async () => {
	stubPagedFetch(150, 100)
	const result = await listDevices(config)
	assert.equal(result.outcome, 'ok')
	if (result.outcome === 'ok') assert.equal(result.data.length, 150)
})

test('pagination does not skip items when the server returns short pages', async () => {
	stubPagedFetch(130, 60)
	const result = await listDevices(config)
	assert.equal(result.outcome, 'ok')
	if (result.outcome === 'ok') {
		assert.deepEqual(
			result.data.map((item) => item.id),
			Array.from({ length: 130 }, (_, i) => String(i)),
		)
	}
})

test('pagination returns an error instead of truncated data', async () => {
	stubPagedFetch(5000, 100)
	const result = await listDevices(config)
	assert.equal(result.outcome, 'error')
})

test('http error messages never contain HTML pages and are capped', () => {
	assert.equal(httpErrorMessage(502, '<html><body>Bad gateway</body></html>'), 'HTTP 502')
	assert.equal(httpErrorMessage(400, JSON.stringify({ message: 'Invalid port' })), 'HTTP 400: Invalid port')
	assert.equal(
		httpErrorMessage(
			500,
			JSON.stringify({ message: 'Internal Server Error', requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
		),
		'HTTP 500: Internal Server Error (requestId 3fa85f64-5717-4562-b3fc-2c963f66afa6)',
	)
	const long = httpErrorMessage(400, JSON.stringify({ message: 'x'.repeat(1000) }))
	assert.ok(long.length < 220)
})

test('devices without a usable ID or with a duplicate ID are skipped', () => {
	const device = (id: unknown, name: string): UnifiDevice =>
		({ id, name, model: 'USW', macAddress: '', state: 'ONLINE', features: [], interfaces: [] }) as UnifiDevice
	const result = partitionValidDevices([
		device('a', 'One'),
		device(undefined, 'Broken'),
		device('', 'Empty'),
		device('a', 'Duplicate'),
		device('b', 'Two'),
	])
	assert.deepEqual(
		result.devices.map((item) => item.id),
		['a', 'b'],
	)
	assert.deepEqual(result.skipped, ['Broken (USW)', 'Empty (USW)', 'Duplicate (USW)'])
})
