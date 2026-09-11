/**
 * Integrations Store
 *
 * Connected third-party accounts and the provider catalogue behind them.
 * Credential VALUES never live here — the backend reports which fields are set,
 * never what they are set to, so nothing in the client can leak one.
 *
 * Deliberately separate from `mcp-servers.svelte.ts`: an account is not an MCP
 * server. Some accounts project one, most later ones will not, and the hub
 * joins the two lists rather than merging the stores.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	IntegrationAccountInfo,
	IntegrationCapability,
	IntegrationProviderInfo,
	IntegrationStatus,
	SecretsHealth
} from '$shared/types/integrations';

let providers = $state<IntegrationProviderInfo[]>([]);
let accounts = $state<IntegrationAccountInfo[]>([]);
let loaded = $state(false);
let secretsHealth = $state<SecretsHealth | null>(null);
let checking = $state<Record<string, boolean>>({});

export const integrationsStore = {
	get providers() { return providers; },
	get accounts() { return accounts; },
	get loaded() { return loaded; },
	get secretsHealth() { return secretsHealth; },
	get checking() { return checking; },

	/** Provider id → its declaration, for rendering a row without a second lookup. */
	get providerById(): Record<string, IntegrationProviderInfo> {
		return Object.fromEntries(providers.map((provider) => [provider.id, provider]));
	},

	/**
	 * The account that owns an `mcp_servers` row, keyed by row id as a string.
	 *
	 * This is what makes a projected connector render as managed and read-only
	 * without the MCP list having to know accounts exist.
	 */
	get accountByMcpTarget(): Record<string, IntegrationAccountInfo> {
		const map: Record<string, IntegrationAccountInfo> = {};
		for (const account of accounts) {
			for (const projection of account.projections) {
				if (projection.targetKind === 'mcp_server') map[projection.targetId] = account;
			}
		}
		return map;
	},

	/** Providers with no account yet — the catalogue half of the hub. */
	get unconnectedProviders(): IntegrationProviderInfo[] {
		const connected = new Set(accounts.map((account) => account.provider));
		return providers.filter((provider) => !connected.has(provider.id));
	},

	async load(): Promise<void> {
		if (loaded) return;
		await this.refresh();
	},

	async refresh(): Promise<void> {
		try {
			const [providerResult, accountResult] = await Promise.all([
				ws.http('integrations:providers', {}),
				ws.http('integrations:list', {})
			]);
			providers = providerResult.providers;
			accounts = accountResult.accounts;
			loaded = true;
		} catch (error) {
			debug.error('settings', 'Failed to load integrations:', error);
			providers = [];
			accounts = [];
			loaded = true;
		}
	},

	async refreshSecretsHealth(): Promise<void> {
		try {
			const { health } = await ws.http('integrations:secrets-health', {});
			secretsHealth = health;
		} catch (error) {
			debug.error('settings', 'Failed to read secrets health:', error);
			secretsHealth = null;
		}
	},

	async connect(input: {
		provider: string;
		label?: string;
		projectId?: string | null;
		credentials: Record<string, string>;
		capabilities?: IntegrationCapability[];
	}): Promise<IntegrationAccountInfo> {
		const { account } = await ws.http('integrations:connect', input);
		await this.refresh();
		void this.checkHealth(account.id);
		return account;
	},

	async update(input: {
		id: string;
		label?: string;
		credentials?: Record<string, string>;
		capabilities?: IntegrationCapability[];
		projectId?: string | null;
		enabled?: boolean;
	}): Promise<IntegrationAccountInfo> {
		const { account } = await ws.http('integrations:update', input);
		await this.refresh();
		return account;
	},

	async disconnect(id: string): Promise<void> {
		await ws.http('integrations:disconnect', { id });
		await this.refresh();
	},

	async checkHealth(id: string): Promise<IntegrationStatus> {
		checking = { ...checking, [id]: true };
		try {
			const result = await ws.http('integrations:health', { id });
			accounts = accounts.map((account) =>
				account.id === id
					? { ...account, status: result.status, statusDetail: result.detail }
					: account
			);
			return result.status;
		} catch (error) {
			debug.error('settings', `Integration health check failed for ${id}:`, error);
			return 'error';
		} finally {
			checking = { ...checking, [id]: false };
		}
	},

	reset(): void {
		providers = [];
		accounts = [];
		loaded = false;
		secretsHealth = null;
		checking = {};
	}
};
