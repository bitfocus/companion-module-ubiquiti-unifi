import type {
	CompanionMigrationAction,
	CompanionMigrationOptionValues,
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

/** Config shape of the module up to v2.x (node-unifi, username/password login). */
type LegacyModuleConfig = {
	host?: string
	port?: string | number
	sslverify?: boolean
	username?: string
	password?: string
	token2FA?: number
	site?: string
}

/**
 * Key under which migrated actions store their port number. The regular UI stores the port per switch
 * (`portIdx__<deviceId>`, see main.ts getSwitchAndPortFields), but at upgrade time the new device ID is
 * not known yet, so main.ts getPortSelection falls back to this key.
 */
export const MIGRATED_PORT_OPTION = 'portIdx'

function optionString(options: CompanionMigrationOptionValues, key: string): string {
	const value = options[key]?.value
	return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

/** Converts an old `POECycle`/`POEMode` action (static switch MAC + port number) to the new switch/port options. */
function migrateSwitchPortOptions(action: CompanionMigrationAction): void {
	action.options.deviceId = { value: optionString(action.options, 'mac').toLowerCase(), isExpression: false }
	action.options[MIGRATED_PORT_OPTION] = {
		value: Number(optionString(action.options, 'port')) || 1,
		isExpression: false,
	}

	delete action.options.mac
	delete action.options.port
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	// Add new upgrade scripts here when config/action/feedback shapes change.
	// Remember that once one has been added it cannot be removed!

	// v1.x: default the site to "default" (unchanged from the original JavaScript module)
	(
		_context: CompanionUpgradeContext<ModuleConfig>,
		{ config }: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> => {
		const legacy = config as (Partial<ModuleConfig> & LegacyModuleConfig) | null
		if (!legacy || legacy.site) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		legacy.site = 'default'
		return { updatedConfig: legacy as ModuleConfig, updatedActions: [], updatedFeedbacks: [] }
	},

	// v2.x -> v3.0: switch from node-unifi (username/password session) to the official Integration API.
	// - config: port becomes a number, `site` becomes `siteId`, username/password move to the legacy fields
	//   (the password into the secrets). The API key has to be entered by the user.
	// - POECycle -> powerCyclePort, POEMode -> setPortPoePersistent. Both used the switch MAC address; the new
	//   actions resolve a MAC address to the device at runtime (see main.ts resolveSwitchId).
	// - ProfilePOEMode has no equivalent (the Integration API has no port profile write access) and is left as is.
	// - Actions whose switch or port is an expression are left as is: the switch field of the new actions cannot be
	//   an expression (it decides which port field is shown), so they cannot be converted reliably.
	(
		_context: CompanionUpgradeContext<ModuleConfig>,
		{ config, secrets, actions }: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> => {
		const updatedActions: CompanionMigrationAction[] = []
		let usesPoeMode = false

		for (const action of actions) {
			if (action.actionId !== 'POECycle' && action.actionId !== 'POEMode') continue
			if (action.options.mac?.isExpression || action.options.port?.isExpression) continue

			if (action.actionId === 'POEMode') {
				// The new action only knows on/off and never sets passive PoE: 'off' stays off, everything else
				// ('auto', '24V passive') becomes on (auto). A mode expression is kept as an equivalent expression.
				const mode = action.options.mode
				action.options.enabled =
					mode?.isExpression && typeof mode.value === 'string'
						? { value: `(${mode.value}) != 'off'`, isExpression: true }
						: { value: optionString(action.options, 'mode') !== 'off', isExpression: false }
				delete action.options.mode
				action.actionId = 'setPortPoePersistent'
				usesPoeMode = true
			} else {
				action.actionId = 'powerCyclePort'
			}
			migrateSwitchPortOptions(action)
			updatedActions.push(action)
		}

		const legacy = config as (Partial<ModuleConfig> & LegacyModuleConfig) | null
		if (!legacy || legacy.siteId !== undefined || (legacy.username === undefined && legacy.site === undefined)) {
			return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
		}

		const updatedConfig: ModuleConfig = {
			host: legacy.host ?? '',
			port: Number(legacy.port) || 443,
			verifyTls: legacy.sslverify === true,
			siteId: legacy.site || 'default',
			pollInterval: 15,
			enableLegacyPoeToggle: usesPoeMode,
			legacyUsername: legacy.username ?? '',
		}
		const updatedSecrets: ModuleSecrets = {
			apiKey: secrets?.apiKey ?? '',
			legacyPassword: secrets?.legacyPassword || legacy.password || '',
		}

		return { updatedConfig, updatedSecrets, updatedActions, updatedFeedbacks: [] }
	},
]
