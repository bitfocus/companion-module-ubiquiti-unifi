import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CompanionMigrationAction, CompanionMigrationOptionValues } from '@companion-module/base'
import { UpgradeScripts } from '../upgrades.js'
import type { ModuleConfig, ModuleSecrets } from '../config.js'

type AnyConfig = Record<string, unknown>

function action(
	actionId: string,
	options: Record<string, unknown>,
	expressions: string[] = [],
): CompanionMigrationAction {
	const migrationOptions: CompanionMigrationOptionValues = {}
	for (const [key, value] of Object.entries(options)) {
		migrationOptions[key] = { value: value as string, isExpression: expressions.includes(key) }
	}
	return { id: `${actionId}-1`, controlId: 'bank:1', actionId, options: migrationOptions }
}

/** Runs all upgrade scripts from `fromIndex` like Companion does, feeding each result into the next script. */
function runUpgrades(config: AnyConfig | null, actions: CompanionMigrationAction[], fromIndex = 0) {
	let currentConfig = config
	let currentSecrets: ModuleSecrets | null = null
	for (const script of UpgradeScripts.slice(fromIndex)) {
		const result = script({} as never, {
			config: currentConfig as ModuleConfig | null,
			secrets: currentSecrets,
			actions,
			feedbacks: [],
		})
		if (result.updatedConfig) currentConfig = result.updatedConfig
		if (result.updatedSecrets) currentSecrets = result.updatedSecrets
	}
	return { config: currentConfig, secrets: currentSecrets, actions }
}

const v2Config: AnyConfig = {
	host: '192.168.1.1',
	port: '8443',
	sslverify: true,
	username: 'companion',
	password: 'secret',
	token2FA: 0,
	site: 'default',
}

test('script 0 keeps the original behaviour (default site)', () => {
	const config: AnyConfig = { host: 'x' }
	const result = UpgradeScripts[0]({} as never, { config: config as never, secrets: null, actions: [], feedbacks: [] })
	assert.equal((result.updatedConfig as AnyConfig | null)?.site, 'default')

	const unchanged = UpgradeScripts[0]({} as never, {
		config: { site: 'abc' } as never,
		secrets: null,
		actions: [],
		feedbacks: [],
	})
	assert.equal(unchanged.updatedConfig, null)
})

test('v2 config is migrated, password moves to the secrets', () => {
	const { config, secrets } = runUpgrades({ ...v2Config }, [])
	assert.deepEqual(config, {
		host: '192.168.1.1',
		port: 8443,
		verifyTls: true,
		siteId: 'default',
		pollInterval: 15,
		enableLegacyPoeToggle: false,
		legacyUsername: 'companion',
	})
	assert.deepEqual(secrets, { apiKey: '', legacyPassword: 'secret' })
})

test('POECycle and POEMode are migrated, passive PoE becomes on', () => {
	const actions = [
		action('POECycle', { mac: 'AA:BB:CC:DD:EE:FF', port: 5 }),
		action('POEMode', { mac: 'aa:bb:cc:dd:ee:ff', port: '3', mode: 'off' }),
		action('POEMode', { mac: 'aa:bb:cc:dd:ee:ff', port: 4, mode: 'pasv24' }),
		action('POEMode', { mac: 'aa:bb:cc:dd:ee:ff', port: 6, mode: 'auto' }),
	]
	const { config } = runUpgrades({ ...v2Config }, actions)

	assert.equal(config?.enableLegacyPoeToggle, true)
	assert.equal(actions[0].actionId, 'powerCyclePort')
	assert.deepEqual(actions[0].options, {
		deviceId: { value: 'aa:bb:cc:dd:ee:ff', isExpression: false },
		portIdx: { value: 5, isExpression: false },
	})
	assert.equal(actions[1].actionId, 'setPortPoePersistent')
	assert.deepEqual(actions[1].options.enabled, { value: false, isExpression: false })
	assert.deepEqual(actions[1].options.portIdx, { value: 3, isExpression: false })
	assert.deepEqual(actions[2].options.enabled, { value: true, isExpression: false })
	assert.deepEqual(actions[3].options.enabled, { value: true, isExpression: false })
	assert.equal(actions[3].options.mode, undefined)
})

test('a mode expression becomes an equivalent on/off expression', () => {
	const actions = [action('POEMode', { mac: 'aa:bb:cc:dd:ee:ff', port: 1, mode: '$(internal:poe_mode)' }, ['mode'])]
	runUpgrades({ ...v2Config }, actions)
	assert.deepEqual(actions[0].options.enabled, { value: "($(internal:poe_mode)) != 'off'", isExpression: true })
})

test('actions with a switch or port expression and ProfilePOEMode are left untouched', () => {
	const actions = [
		action('POECycle', { mac: '$(custom:mac)', port: 1 }, ['mac']),
		action('POEMode', { mac: 'aa:bb:cc:dd:ee:ff', port: '$(custom:port)', mode: 'off' }, ['port']),
		action('ProfilePOEMode', { profile: 'x', mode: 'off' }),
	]
	runUpgrades({ ...v2Config }, actions)
	assert.deepEqual(
		actions.map((a) => a.actionId),
		['POECycle', 'POEMode', 'ProfilePOEMode'],
	)
	assert.equal(actions[1].options.mode?.value, 'off')
})

test('migration is idempotent and leaves new style configs alone', () => {
	const { config } = runUpgrades({ ...v2Config }, [])
	const again = UpgradeScripts[1]({} as never, {
		config: config as never,
		secrets: null,
		actions: [],
		feedbacks: [],
	})
	assert.equal(again.updatedConfig, null)
})
