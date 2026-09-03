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
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';
import type { QwenProviderPresetId } from '$shared/types/unified';

export interface QwenAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
	preset: QwenProviderPresetId;
}

let accounts = $state<QwenAccountItem[]>([]);
const cache = createCachedLoad('Qwen accounts');

export const qwenAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<QwenAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<QwenAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: QwenAccountItem[]) {
		accounts = newAccounts;
		cache.markLoaded();
	},

	/** Reset store state. */
	reset() {
		accounts = [];
		cache.reset();
	}
};

/**
 * The one request behind this store.
 *
 * It deliberately does not catch: `createCachedLoad` decides what a failure
 * means, and the answer is "do not cache it" — blanking `accounts` here is what
 * used to turn a timeout into an account list that stayed empty for the rest of
 * the session.
 */
async function load(): Promise<void> {
	const result = await ws.http('engine:qwen-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Qwen accounts loaded: ${accounts.length}`);
}
