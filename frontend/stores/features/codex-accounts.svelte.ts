/**
 * Codex Accounts Store
 *
 * Shared reactive store for OpenAI Codex accounts. Mirrors the
 * claude-accounts / copilot-accounts shape so EngineModelPicker can wire
 * Codex into the existing single-account-list dropdown without a separate
 * picker UI. Adds `authMode` (api_key | chatgpt) so the model picker can
 * filter ChatGPT-only models when the active Codex account is API-key.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface CodexAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	authMode: 'api_key' | 'chatgpt' | null;
	createdAt: string;
}

let accounts = $state<CodexAccountItem[]>([]);
const cache = createCachedLoad('Codex accounts');

export const codexAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return cache.loaded; },

	/** Fetch accounts from backend. Idempotent — skips only if already loaded. */
	async fetch(): Promise<CodexAccountItem[]> {
		await cache.ensure(load);
		return accounts;
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<CodexAccountItem[]> {
		await cache.refresh(load);
		return accounts;
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: CodexAccountItem[]) {
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
	const result = await ws.http('engine:codex-accounts-list', {});
	accounts = result.accounts;
	debug.log('settings', `Codex accounts loaded: ${accounts.length}`);
}
