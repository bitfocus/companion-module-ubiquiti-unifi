// End-to-end: the real node-unifi library against a fake HTTPS controller whose sessions can be
// expired, reproducing the "stale connection, PoE buttons stop working until restart" failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import unifi from 'node-unifi'
import { createHarness } from './helpers/harness.js'

function selfSignedCert() {
	const dir = mkdtempSync(path.join(tmpdir(), 'unifi-cert-'))
	const key = path.join(dir, 'key.pem'),
		cert = path.join(dir, 'cert.pem')
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			key,
			'-out',
			cert,
			'-days',
			'1',
			'-subj',
			'/CN=localhost',
		],
		{ stdio: 'ignore' },
	)
	return { key: readFileSync(key), cert: readFileSync(cert) }
}

let cert
try {
	cert = selfSignedCert()
} catch {
	cert = undefined
}

function fakeController() {
	const sessions = new Set()
	const commands = []
	let counter = 0,
		logins = 0
	const json = (res, status, body) => {
		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(body))
	}
	const server = https.createServer(cert, (req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			const sid = /unifises=(\w+)/.exec(req.headers.cookie || '')?.[1]
			if (req.url === '/') {
				res.writeHead(302, { location: '/manage' })
				return res.end()
			}
			if (req.url === '/api/login') {
				logins++
				const s = `s${++counter}`
				sessions.add(s)
				res.setHeader('set-cookie', `unifises=${s}; Path=/`)
				return json(res, 200, { meta: { rc: 'ok' }, data: [] })
			}
			if (!sessions.has(sid)) return json(res, 401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] })
			if (req.url === '/logout') {
				sessions.delete(sid)
				return json(res, 200, { meta: { rc: 'ok' }, data: [] })
			}
			if (req.url.endsWith('/cmd/devmgr')) commands.push(JSON.parse(body))
			json(res, 200, { meta: { rc: 'ok' }, data: [{ name: 'switch', mac: 'aa:bb:cc:dd:ee:ff' }] })
		})
	})
	return {
		server,
		commands,
		expireAll: () => sessions.clear(),
		get logins() {
			return logins
		},
	}
}

async function until(predicate, ms = 5000) {
	const end = Date.now() + ms
	while (!predicate()) {
		if (Date.now() > end) throw new Error('condition not met in time')
		await new Promise((r) => setTimeout(r, 10))
	}
}

test(
	'PoE power cycle still works after the controller expires the session (no restart)',
	{ skip: !cert && 'openssl unavailable' },
	async () => {
		const fake = fakeController()
		await new Promise((r) => fake.server.listen(0, '127.0.0.1', r))
		const { instance, logs } = createHarness([], { unifi, realTimers: true })
		try {
			await instance.init({
				host: '127.0.0.1',
				port: fake.server.address().port,
				username: 'u',
				password: 'p',
				site: 'default',
				sslverify: false,
			})
			await until(() => instance.statuses.at(-1) === 'ok')

			await instance.doPowerCyclePort('aa:bb:cc:dd:ee:ff', 3)
			assert.equal(fake.commands.length, 1)

			// Session expires on the controller (timeout, controller restart, admin logout...).
			fake.expireAll()
			const loginsBefore = fake.logins

			await instance.doPowerCyclePort('aa:bb:cc:dd:ee:ff', 4)
			assert.equal(fake.commands.length, 2, `command not delivered; logs: ${JSON.stringify(logs)}`)
			assert.deepEqual(fake.commands[1], { cmd: 'power-cycle', mac: 'aa:bb:cc:dd:ee:ff', port_idx: 4 })
			assert.ok(fake.logins > loginsBefore, 'expected a genuine re-login')
			assert.equal(
				logs.some(([level]) => level === 'error'),
				false,
				JSON.stringify(logs),
			)
			assert.equal(instance.statuses.at(-1), 'ok')
		} finally {
			await instance.destroy()
			fake.server.closeAllConnections()
			await new Promise((r) => fake.server.close(r))
		}
	},
)

test(
	'node-unifi cannot renew an expired session on an existing Controller (why we rebuild it)',
	{ skip: !cert && 'openssl unavailable' },
	async () => {
		// Guards the core assumption: if a future node-unifi fixes re-login, this fails and the
		// rebuild-per-recovery approach can be revisited.
		const fake = fakeController()
		await new Promise((r) => fake.server.listen(0, '127.0.0.1', r))
		const controller = new unifi.Controller({
			host: '127.0.0.1',
			port: fake.server.address().port,
			username: 'u',
			password: 'p',
			sslverify: false,
		})
		try {
			await controller.login()
			fake.expireAll()
			await controller.login()
			await assert.rejects(controller.getAccessDevicesBasic(), /401/)
		} finally {
			fake.server.closeAllConnections()
			await new Promise((r) => fake.server.close(r))
		}
	},
)
