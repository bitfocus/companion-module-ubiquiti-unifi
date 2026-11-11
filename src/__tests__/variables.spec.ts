import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDeviceSlugs } from '../variables.js'

test('unique device names keep their plain slug', () => {
	const slugs = buildDeviceSlugs([
		{ id: 'a', name: 'FOH-SW-Audio', macAddress: 'aa:bb:cc:00:00:01' },
		{ id: 'b', name: 'Core Switch', macAddress: 'aa:bb:cc:00:00:02' },
	])
	assert.equal(slugs.get('a'), 'foh_sw_audio')
	assert.equal(slugs.get('b'), 'core_switch')
})

test('colliding or empty names get a MAC suffix', () => {
	const slugs = buildDeviceSlugs([
		{ id: 'a', name: 'Stage Switch', macAddress: 'aa:bb:cc:11:22:33' },
		{ id: 'b', name: 'stage-switch', macAddress: 'aa:bb:cc:44:55:66' },
		{ id: 'c', name: '---', macAddress: 'aa:bb:cc:77:88:99' },
	])
	assert.equal(slugs.get('a'), 'stage_switch_112233')
	assert.equal(slugs.get('b'), 'stage_switch_445566')
	assert.equal(slugs.get('c'), 'device_778899')
})
