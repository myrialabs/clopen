/**
 * Claude Accounts Store
 *
 * Shared reactive store for Claude Code accounts.
 * Used by both AIEnginesSettings and EngineModelPicker to stay in sync.
 * Fetches from backend via `engine:claude-accounts-list`.
 */

import ws from '$frontend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export interface ClaudeAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

let accounts = $state<ClaudeAccountItem[]>([]);
let loaded = $state(false);

export const claudeAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	/** Fetch accounts from backend. Idempotent — skips if already loaded. */
	async fetch(): Promise<ClaudeAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<ClaudeAccountItem[]> {
		try {
			const result = await ws.http('engine:claude-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Claude accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: ClaudeAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	/** Reset store state. */
	reset() {
		accounts = [];
		loaded = false;
	}
};
