/**
 * Cline Provider Presets Store
 *
 * The Cline provider catalog (id, name, supported auth modes, credential fields)
 * for the login picker. Fetched from backend via `engine:cline-presets-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';
import type { ClineProviderPreset } from '$shared/types/unified';

let presets = $state<ClineProviderPreset[]>([]);
const cache = createCachedLoad('Cline presets');

export const clinePresetsStore = {
	get presets() { return presets; },
	get loaded() { return cache.loaded; },

	async fetch(): Promise<ClineProviderPreset[]> {
		await cache.ensure(load);
		return presets;
	},

	async refresh(): Promise<ClineProviderPreset[]> {
		await cache.refresh(load);
		return presets;
	},

	reset() {
		presets = [];
		cache.reset();
	}
};

/**
 * The one request behind this store. It does not catch — see the note in
 * `createCachedLoad`: a failed load must not be cached as an empty catalog,
 * because nothing would ever ask for it again.
 */
async function load(): Promise<void> {
	const result = await ws.http('engine:cline-presets-list', {});
	presets = result.presets;
	debug.log('settings', `Cline presets loaded: ${presets.length}`);
}
