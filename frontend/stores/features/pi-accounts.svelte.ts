/**
 * Pi Accounts Store
 *
 * Shared reactive store for Pi accounts. Each account is tied to a pi-ai
 * provider (Anthropic, OpenAI, …) and an auth type (api_key or oauth).
 * Fetches from backend via `engine:pi-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface PiAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
	provider: string;
	authType: 'api_key' | 'oauth';
	/** Non-secret provider-scoped config (account id, base url, …) for edit prefill. */
	env: Record<string, string>;
}

let accounts = $state<PiAccountItem[]>([]);
const cache = createCachedLoad('Pi accounts');

export const piAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<PiAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<PiAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: PiAccountItem[]) {
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
	const result = await ws.http('engine:pi-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Pi accounts loaded: ${accounts.length}`);
}
