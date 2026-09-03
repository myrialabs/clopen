/**
 * Pi Provider Presets Store
 *
 * The Pi provider catalog (id, name, supported auth modes) for the login picker.
 * Fetched from backend via `engine:pi-presets-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';
import type { PiProviderPreset } from '$shared/types/unified';

let presets = $state<PiProviderPreset[]>([]);
const cache = createCachedLoad('Pi presets');

export const piPresetsStore = {
	get presets() { return presets; },
	get loaded() { return cache.loaded; },

	async fetch(): Promise<PiProviderPreset[]> {
		await cache.ensure(load);
		return presets;
	},

	async refresh(): Promise<PiProviderPreset[]> {
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
	const result = await ws.http('engine:pi-presets-list', {});
	presets = result.presets;
	debug.log('settings', `Pi presets loaded: ${presets.length}`);
}
