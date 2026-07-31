import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'obsidian-sync-engine',
		'esbuild.config.mjs',
		'package-plugin.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				__CLIENT_LOGGING_ENABLED__: 'readonly',
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// src/sync is intentionally pure/host-agnostic (no Obsidian imports) so
		// it can run under `bun test` outside the Obsidian renderer, where
		// `window` doesn't exist. The window-timer rules assume a browser
		// global that isn't available there, so they don't apply here.
		files: ['src/sync/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-global-this': 'off',
		},
	},
);
