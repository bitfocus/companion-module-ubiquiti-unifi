import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getActionDefinitions } from '../actions.js'

test('update retains the upstream UniFi identity and existing button action options', () => {
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
	const manifest = JSON.parse(readFileSync(new URL('../companion/manifest.json', import.meta.url)))
	assert.equal(pkg.name, 'ubiquiti-unifi')
	assert.equal(manifest.id, 'ubiquiti-unifi')
	assert.equal(manifest.name, 'ubiquiti-unifi')
	assert.equal(manifest.shortname, 'unifi')
	assert.deepEqual(manifest.legacyIds, ['unifi'])
	assert.deepEqual(manifest.products, ['Unifi', 'USW'])
	const actions = getActionDefinitions({ switchMacAddressOptions: [], portProfileOptions: [] })
	assert.deepEqual(Object.keys(actions), ['POECycle', 'POEMode', 'ProfilePOEMode'])
	assert.deepEqual(
		actions.POECycle.options.map((option) => option.id),
		['mac', 'port'],
	)
	assert.deepEqual(
		actions.POEMode.options.map((option) => option.id),
		['mac', 'port', 'mode'],
	)
	assert.deepEqual(
		actions.ProfilePOEMode.options.map((option) => option.id),
		['profile', 'mode'],
	)
})
