/**
 * Qwen Provider Presets Store
 *
 * Caches the static Qwen preset catalog (DashScope CN/INTL, OpenRouter,
 * Fireworks) fetched from the backend via `engine:qwen-presets-list`. The
 * runtime data lives with the adapter at
 * `backend/engine/adapters/qwen/presets.ts` — the frontend mirrors it through
 * this store so it never imports from `$backend` directly.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';
import type { QwenProviderPreset, QwenProviderPresetId } from '$shared/types/unified';

let presets = $state<QwenProviderPreset[]>([]);
let defaultPreset = $state<QwenProviderPresetId>('dashscope-intl');
const cache = createCachedLoad('Qwen presets');

export const qwenPresetsStore = {
	get presets() { return presets; },
	get defaultPreset() { return defaultPreset; },
	get loaded() { return cache.loaded; },

	getPreset(id: QwenProviderPresetId | string): QwenProviderPreset | undefined {
		return presets.find(p => p.id === id);
	},

	async fetch(): Promise<QwenProviderPreset[]> {
		await cache.ensure(load);
		return presets;
	},

	async refresh(): Promise<QwenProviderPreset[]> {
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
 * because nothing would ever ask for it again. `defaultPreset` deliberately
 * keeps its last good value on failure rather than falling back, so the picker
 * never silently re-points an account at a different endpoint.
 */
async function load(): Promise<void> {
	const result = await ws.http('engine:qwen-presets-list', {});
	presets = result.presets;
	defaultPreset = result.defaultPreset;
	debug.log('settings', `Qwen presets loaded: ${presets.length}`);
}
