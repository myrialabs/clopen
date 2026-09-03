/**
 * Cursor Accounts Store
 *
 * Shared reactive store for Cursor accounts (one API key per account).
 * Used by AIEnginesSettings (and any future Cursor-aware UI) to stay in sync.
 * Fetches from backend via `engine:cursor-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface CursorAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

let accounts = $state<CursorAccountItem[]>([]);
const cache = createCachedLoad('Cursor accounts');

export const cursorAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<CursorAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<CursorAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: CursorAccountItem[]) {
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
	const result = await ws.http('engine:cursor-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Cursor accounts loaded: ${accounts.length}`);
}
