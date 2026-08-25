/**
 * Pi Accounts Store
 *
 * Shared reactive store for Pi accounts. Each account is tied to a pi-ai
 * provider (Anthropic, OpenAI, …) and an auth type (api_key or oauth).
 * Fetches from backend via `engine:pi-accounts-list`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

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
let loaded = $state(false);

export const piAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	async fetch(): Promise<PiAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	async refresh(): Promise<PiAccountItem[]> {
		try {
			const result = await ws.http('engine:pi-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Pi accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	set(newAccounts: PiAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	reset() {
		accounts = [];
		loaded = false;
	}
};
