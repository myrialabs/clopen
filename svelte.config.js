import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Svelte Configuration (SPA Mode - No SvelteKit)
 * @type {import('@sveltejs/vite-plugin-svelte').Options}
 */
const config = {
	// Vite preprocessor for TypeScript, SCSS, etc.
	preprocess: vitePreprocess(),

	// Compiler options
	compilerOptions: {
		// Enable Svelte 5 runes mode
		runes: true,
		// Suppress a11y warnings globally — this is a dev tool, not a public-facing website
		warningFilter: (warning) => !warning.code.startsWith('a11y')
	}
};

export default config;
