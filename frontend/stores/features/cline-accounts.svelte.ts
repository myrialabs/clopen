/**
 * Cline Accounts Store
 *
 * Shared reactive store for Cline accounts. Each account is tied to a Cline
 * provider (Anthropic, OpenAI, the Cline account, …) and an auth method
 * (api_key or oauth). Fetches from backend via `engine:cline-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface ClineAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
	provider: string;
	authMethod: 'api_key' | 'oauth';
	/** Non-secret provider-scoped fields (base url, region, …) for edit prefill. */
	fields: Record<string, string>;
}

let accounts = $state<ClineAccountItem[]>([]);
const cache = createCachedLoad('Cline accounts');

export const clineAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<ClineAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<ClineAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: ClineAccountItem[]) {
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
	const result = await ws.http('engine:cline-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Cline accounts loaded: ${accounts.length}`);
}
