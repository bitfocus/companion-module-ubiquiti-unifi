// @ts-check

/**
 * @type {import('@companion-module/base').CompanionStaticUpgradeScript<any>[]}
 */
export const UpgradeScripts = [
	(context, props) => {
		/**
		 * @type {import('@companion-module/base').CompanionStaticUpgradeResult<any>}
		 */
		const result = {
			updatedActions: [],
			updatedFeedbacks: [],
			updatedConfig: null,
		}

		if (props.config && !props.config.site) {
			result.updatedConfig = props.config
			result.updatedConfig.site = 'default'
		}

		return result
	},
]
