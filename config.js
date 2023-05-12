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
			width: 12,
			regex: Regex.PORT,
			default: '8443',
			required: true,
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
			width: 12,
			required: true,
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'Password',
			width: 12,
			required: true,
		},
	]
}
