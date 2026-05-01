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
import type { QwenProviderPreset, QwenProviderPresetId } from '$shared/types/unified';

let presets = $state<QwenProviderPreset[]>([]);
let defaultPreset = $state<QwenProviderPresetId>('dashscope-intl');
let loaded = $state(false);

export const qwenPresetsStore = {
	get presets() { return presets; },
	get defaultPreset() { return defaultPreset; },
	get loaded() { return loaded; },

	getPreset(id: QwenProviderPresetId | string): QwenProviderPreset | undefined {
		return presets.find(p => p.id === id);
	},

	async fetch(): Promise<QwenProviderPreset[]> {
		if (loaded) return presets;
		return this.refresh();
	},

	async refresh(): Promise<QwenProviderPreset[]> {
		try {
			const result = await ws.http('engine:qwen-presets-list', {});
			presets = result.presets;
			defaultPreset = result.defaultPreset;
			loaded = true;
			debug.log('settings', `Qwen presets loaded: ${presets.length}`);
			return presets;
		} catch {
			presets = [];
			loaded = true;
			return [];
		}
	},

	reset() {
		presets = [];
		loaded = false;
	}
};
