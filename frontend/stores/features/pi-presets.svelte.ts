/**
 * Pi Provider Presets Store
 *
 * The Pi provider catalog (id, name, supported auth modes) for the login picker.
 * Fetched from backend via `engine:pi-presets-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { PiProviderPreset } from '$shared/types/unified';

let presets = $state<PiProviderPreset[]>([]);
let loaded = $state(false);

export const piPresetsStore = {
	get presets() { return presets; },
	get loaded() { return loaded; },

	async fetch(): Promise<PiProviderPreset[]> {
		if (loaded) return presets;
		return this.refresh();
	},

	async refresh(): Promise<PiProviderPreset[]> {
		try {
			const result = await ws.http('engine:pi-presets-list', {});
			presets = result.presets;
			loaded = true;
			debug.log('settings', `Pi presets loaded: ${presets.length}`);
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
