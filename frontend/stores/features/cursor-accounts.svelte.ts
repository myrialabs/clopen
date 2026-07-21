/**
 * Cursor Accounts Store
 *
 * Shared reactive store for Cursor accounts (one API key per account).
 * Used by AIEnginesSettings (and any future Cursor-aware UI) to stay in sync.
 * Fetches from backend via `engine:cursor-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface CursorAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

let accounts = $state<CursorAccountItem[]>([]);
let loaded = $state(false);

export const cursorAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	/** Fetch accounts from backend. Idempotent — skips if already loaded. */
	async fetch(): Promise<CursorAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<CursorAccountItem[]> {
		try {
			const result = await ws.http('engine:cursor-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Cursor accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: CursorAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	/** Reset store state. */
	reset() {
		accounts = [];
		loaded = false;
	}
};
