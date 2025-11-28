import js from '@eslint/js'

export default [
	{
		ignores: ['node_modules/**', 'dist/**'],
	},
	{
		files: ['**/*.js', '**/*.mjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				console: 'readonly',
				process: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
			},
		},
		rules: {
			...js.configs.recommended.rules,
		},
	},
]
