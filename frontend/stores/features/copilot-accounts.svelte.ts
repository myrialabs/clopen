/**
 * Copilot Accounts Store
 *
 * Shared reactive store for GitHub Copilot accounts.
 * Used by AIEnginesSettings (and any future Copilot-aware UI) to stay in sync.
 * Fetches from backend via `engine:copilot-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface CopilotAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

let accounts = $state<CopilotAccountItem[]>([]);
let loaded = $state(false);

export const copilotAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	/** Fetch accounts from backend. Idempotent — skips if already loaded. */
	async fetch(): Promise<CopilotAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	/** Force re-fetch accounts from backend. */
	async refresh(): Promise<CopilotAccountItem[]> {
		try {
			const result = await ws.http('engine:copilot-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Copilot accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	/** Update accounts list directly (avoids round-trip to backend). */
	set(newAccounts: CopilotAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	/** Reset store state. */
	reset() {
		accounts = [];
		loaded = false;
	}
};
