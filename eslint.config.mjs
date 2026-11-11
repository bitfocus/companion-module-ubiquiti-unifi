import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

export default [
	...baseConfig,
	{
		// node:test registers tests synchronously, the returned promises are handled by the runner
		files: ['src/__tests__/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},
]
