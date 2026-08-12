import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

// ─────────────────────────────────────────────────────────────────────────────
// Shipped-runtime import guard
//
// The published package ships only `dependencies` (see package.json "files" —
// bin, backend, shared, scripts/start.ts are shipped as SOURCE and executed
// straight off disk). Anything in `devDependencies` — every engine SDK, plus the
// build/lint toolchain — is absent on an end user's install.
//
// A value import of such a package therefore resolves fine in this repo (where
// devDependencies are installed) and passes check/lint/test/build/dev, but
// crashes the backend at boot for every user:
//
//   error: Cannot find module '@earendil-works/pi-ai' from '…/adapters/pi/stream.ts'
//
// Because the failure has no local signal, it cannot be caught by review alone.
// So we make it a lint error, with the restricted list DERIVED from package.json
// rather than hand-maintained: adding a new engine SDK to devDependencies puts
// it under the guard automatically.
//
// Type-only imports stay legal (they are erased at runtime). Engine SDKs must be
// reached through `loadEngineSdk()`, which resolves them from the clopen-managed
// stack dir and degrades to a typed "engine not installed" error.
// ─────────────────────────────────────────────────────────────────────────────

const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
);

/** Files shipped as source and executed by the end user's runtime. */
const SHIPPED_RUNTIME = [
	'bin/**/*.{ts,js}',
	'backend/**/*.{ts,js}',
	'shared/**/*.{ts,js}',
	'scripts/start.ts',
];

const devOnlyPackages = Object.keys(pkg.devDependencies ?? {});

const devDependencyImportGuard = {
	files: SHIPPED_RUNTIME,
	// Tests run inside this repo, where devDependencies are installed.
	ignores: ['**/*.test.ts'],
	rules: {
		'@typescript-eslint/no-restricted-imports': ['error', {
			patterns: [{
				group: devOnlyPackages.flatMap(name => [name, `${name}/*`]),
				allowTypeImports: true,
				message:
					'This package is a devDependency, so it is NOT shipped to end users — a value ' +
					'import here crashes the backend at boot on a fresh install. Use `import type` ' +
					'for types, and load engine SDKs at runtime via loadEngineSdk() from ' +
					'$backend/engine/sdk-loader.'
			}]
		}]
	}
};

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

	devDependencyImportGuard,

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
