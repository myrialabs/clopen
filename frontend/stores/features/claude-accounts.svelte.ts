/**
 * Claude Accounts Store
 *
 * Shared reactive store for Claude Code accounts.
 * Used by both AIEnginesSettings and EngineModelPicker to stay in sync.
 * Fetches from backend via `engine:claude-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface ClaudeAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

let accounts = $state<ClaudeAccountItem[]>([]);
const cache = createCachedLoad('Claude accounts');

export const claudeAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<ClaudeAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<ClaudeAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: ClaudeAccountItem[]) {
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
	const result = await ws.http('engine:claude-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Claude accounts loaded: ${accounts.length}`);
}
