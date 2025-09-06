// @ts-check

import { Regex } from '@companion-module/base'

/**
 * @returns {import("@companion-module/base").SomeCompanionConfigField[]}
 */
export function getConfigFields() {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module will control network switches via a UniFi controller.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP/Host',
			width: 12,
			required: true,
		},
		{
			type: 'textinput',
			id: 'port',
			label: 'Target Port',
			width: 6,
			regex: Regex.PORT,
			default: '8443',
			required: true,
		},
		{
			type: 'checkbox',
			label: 'SSL Verify',
			id: 'sslverify',
			default: false,
			width: 6,
		},
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Username/Password',
			value:
				'These will be stored in clear text within the Companion config.<br>It is encouraged that you create a unique username and password for this instance.',
		},
		{
			type: 'textinput',
			id: 'username',
			label: 'Username',
			width: 6,
			required: true,
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'Password',
			width: 6,
			required: true,
		},
		{
			type: 'number',
			id: 'token2FA',
			label: '2FA Token',
			width: 6,
			min: 0,
			max: 999999,
			default: 0,
			required: false,
		},
		{
			type: 'textinput',
			label: 'Site',
			id: 'site',
			default: 'default',
			width: 6,
			required: true,
		},
	]
}
