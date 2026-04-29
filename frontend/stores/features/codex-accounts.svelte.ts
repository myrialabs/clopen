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

export interface CodexAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	authMode: 'api_key' | 'chatgpt' | null;
	createdAt: string;
}

let accounts = $state<CodexAccountItem[]>([]);
let loaded = $state(false);

export const codexAccountsStore = {
	get accounts() { return accounts; },
	get loaded() { return loaded; },

	async fetch(): Promise<CodexAccountItem[]> {
		if (loaded) return accounts;
		return this.refresh();
	},

	async refresh(): Promise<CodexAccountItem[]> {
		try {
			const result = await ws.http('engine:codex-accounts-list', {});
			accounts = result.accounts;
			loaded = true;
			debug.log('settings', `Codex accounts loaded: ${accounts.length}`);
			return accounts;
		} catch {
			accounts = [];
			loaded = true;
			return [];
		}
	},

	set(newAccounts: CodexAccountItem[]) {
		accounts = newAccounts;
		loaded = true;
	},

	reset() {
		accounts = [];
		loaded = false;
	}
};
