/**
 * Cline Provider Presets Store
 *
 * The Cline provider catalog (id, name, supported auth modes, credential fields)
 * for the login picker. Fetched from backend via `engine:cline-presets-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { ClineProviderPreset } from '$shared/types/unified';

let presets = $state<ClineProviderPreset[]>([]);
let loaded = $state(false);

export const clinePresetsStore = {
	get presets() { return presets; },
	get loaded() { return loaded; },

	async fetch(): Promise<ClineProviderPreset[]> {
		if (loaded) return presets;
		return this.refresh();
	},

	async refresh(): Promise<ClineProviderPreset[]> {
		try {
			const result = await ws.http('engine:cline-presets-list', {});
			presets = result.presets;
			loaded = true;
			debug.log('settings', `Cline presets loaded: ${presets.length}`);
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
