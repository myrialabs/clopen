import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],

	// Global rules for all files
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				NodeJS: 'readonly'
			}
		},
		rules: {
			// --- TypeScript ---
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-unused-expressions': 'off',
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',

			// --- JavaScript ---
			'no-empty': ['error', { allowEmptyCatch: true }],
			'no-control-regex': 'off',
			'no-case-declarations': 'off',
			'no-useless-escape': 'error',
			'no-useless-catch': 'error',
			'prefer-const': 'error'
		}
	},

	// Svelte 5 specific rules
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		},
		rules: {
			// {@html} is used for trusted content (icons, rendered markdown)
			'svelte/no-at-html-tags': 'off',
			// Terminal & Monaco need direct DOM access
			'svelte/no-dom-manipulating': 'off',
			// Svelte 5 stylistic — handled by svelte-check
			'svelte/require-each-key': 'off',
			'svelte/prefer-svelte-reactivity': 'off',
			'svelte/prefer-writable-derived': 'off',
			'svelte/no-useless-children-snippet': 'off',
			'svelte/no-useless-mustaches': 'off',
			// svelte-check handles these better in .svelte files
			'@typescript-eslint/no-unused-vars': 'off',
			// `let` is needed for $state and $bindable in Svelte 5
			'prefer-const': 'off'
		}
	},

	// Ignores
	{
		ignores: ['build/', 'dist/', '**/*.svelte.ts']
	}
];
