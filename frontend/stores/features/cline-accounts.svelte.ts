/**
 * Cline Accounts Store
 *
 * Shared reactive store for Cline accounts. Each account is tied to a Cline
 * provider (Anthropic, OpenAI, the Cline account, …) and an auth method
 * (api_key or oauth). Fetches from backend via `engine:cline-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

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
let loaded = $state(false);

export const clineAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	async fetch(): Promise<ClineAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	async refresh(): Promise<ClineAccountItem[]> {
		try {
			const result = await ws.http('engine:cline-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Cline accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	set(newAccounts: ClineAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	reset() {
		accounts = [];
		loaded = false;
	}
};
