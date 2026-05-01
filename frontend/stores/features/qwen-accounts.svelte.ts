/**
 * Qwen Code Accounts Store
 *
 * Shared reactive store for Qwen Code accounts.
 * Used by AIEnginesSettings (and any future Qwen-aware UI) to stay in sync.
 * Fetches from backend via `engine:qwen-accounts-list`.
 *
 * Each account carries its own preset — the preset alone determines which
 * OpenAI-compatible endpoint a stream targets.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { QwenProviderPresetId } from '$shared/types/unified';

export interface QwenAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
	preset: QwenProviderPresetId;
}

let accounts = $state<QwenAccountItem[]>([]);
let loaded = $state(false);

export const qwenAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	/** Fetch accounts from backend. Idempotent — skips if already loaded. */
	async fetch(): Promise<QwenAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<QwenAccountItem[]> {
		try {
			const result = await ws.http('engine:qwen-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Qwen accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: QwenAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	/** Reset store state. */
	reset() {
		accounts = [];
		loaded = false;
	}
};
