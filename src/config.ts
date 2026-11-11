import type { SomeCompanionConfigField } from '@companion-module/base'
import type { UnifiSite } from './unifi-client.js'

export type ModuleConfig = {
	host: string
	port: number
	verifyTls: boolean
	siteId: string
	pollInterval: number
	enableLegacyPoeToggle: boolean
	legacyUsername: string
}

export type ModuleSecrets = {
	apiKey: string
	legacyPassword: string
}

/**
 * Before the first successful connection the module does not know the available sites yet, so a free text
 * field is shown. Once `GET /sites` has succeeded (see main.ts resolveSiteId) it becomes a dropdown of the
 * real sites. With only one site the connection ignores the value anyway (see resolveSiteId), so the dropdown
 * is only offered for two or more sites.
 */
function siteField(knownSites: UnifiSite[]): SomeCompanionConfigField {
	if (knownSites.length <= 1) {
		return {
			type: 'textinput',
			id: 'siteId',
			label: 'Site ID',
			tooltip:
				'ID or name of the UniFi site. Usually "default" on single-site consoles. ' +
				'With multiple sites a dropdown is offered here after the first successful connection.',
			width: 6,
			default: 'default',
		}
	}

	return {
		type: 'dropdown',
		id: 'siteId',
		label: 'Site',
		tooltip: 'Site on the UniFi console.',
		width: 6,
		choices: knownSites.map((site) => ({ id: site.id, label: `${site.name} (${site.internalReference})` })),
		default: knownSites[0]?.id ?? 'default',
	}
}

export function GetConfigFields(knownSites: UnifiSite[] = []): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'UniFi Network',
			width: 12,
			value:
				'Connects to the official, local <b>UniFi Network Integration API</b> (API key authentication). ' +
				'Create the API key on the console under <i>Settings → Control Plane → Integrations</i>.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Host / IP',
			tooltip: 'IP address or hostname of the UniFi console (UDM, UDM Pro, UDR, Cloud Key, ...)',
			width: 8,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Port',
			tooltip: 'Usually 443 on UniFi OS consoles',
			width: 4,
			min: 1,
			max: 65535,
			default: 443,
		},
		{
			type: 'checkbox',
			id: 'verifyTls',
			label: 'Verify TLS certificate',
			tooltip:
				'Only enable if the console uses a certificate trusted by this machine. ' +
				'UniFi consoles use a self-signed certificate by default.',
			width: 12,
			default: false,
		},
		{
			type: 'secret-text',
			id: 'apiKey',
			label: 'API Key',
			tooltip: 'Settings → Control Plane → Integrations → Create API Key',
			width: 12,
		},
		siteField(knownSites),
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Poll interval (seconds, 0 = off)',
			tooltip: 'How often device and port state is refreshed for feedbacks and variables',
			width: 6,
			min: 0,
			max: 3600,
			default: 15,
		},
		{
			type: 'checkbox',
			id: 'enableLegacyPoeToggle',
			label: 'Enable persistent PoE on/off (legacy API)',
			tooltip:
				'Enables an additional action that switches PoE on or off permanently. ' +
				'It uses the old, private controller API (not the official one) and requires a ' +
				'local admin account WITHOUT 2FA/cloud SSO. May break without notice after firmware updates.',
			width: 12,
			default: false,
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'legacyUsername',
			label: 'Legacy username (local admin, only for PoE on/off)',
			tooltip: 'Only required if "persistent PoE on/off" is enabled above. Not a Ubiquiti cloud account.',
			width: 6,
			isVisibleExpression: '$(options:enableLegacyPoeToggle)',
		},
		{
			type: 'secret-text',
			id: 'legacyPassword',
			label: 'Legacy password',
			tooltip: 'Only required if "persistent PoE on/off" is enabled above.',
			width: 6,
			isVisibleExpression: '$(options:enableLegacyPoeToggle)',
		},
	]
}
