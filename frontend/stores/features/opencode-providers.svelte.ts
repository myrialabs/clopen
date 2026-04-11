/**
 * OpenCode Providers Store
 *
 * Shared reactive store for OpenCode provider + account management.
 * Used by AIEnginesSettings to display and manage providers.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface OpenCodeAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

export interface OpenCodeProviderItem {
	id: number;
	providerId: string;
	name: string;
	npm: string;
	apiUrl: string | null;
	options: string;
	isEnabled: boolean;
	createdAt: string;
	accounts: OpenCodeAccountItem[];
}

export interface ModelsDevProviderItem {
	id: string;
	name: string;
	npm: string;
	env: string[];
	api: string | null;
}

let providers = $state<OpenCodeProviderItem[]>([]);
let catalog = $state<ModelsDevProviderItem[]>([]);
let catalogCachedAt = $state<string | null>(null);
let loaded = $state(false);
let catalogLoaded = $state(false);

export const opencodeProvidersStore = {
	get providers() { return providers; },
	get catalog() { return catalog; },
	get catalogCachedAt() { return catalogCachedAt; },
	get loaded() { return loaded; },
	get catalogLoaded() { return catalogLoaded; },

	// ========================================================================
	// Providers
	// ========================================================================

	async fetchProviders(): Promise<OpenCodeProviderItem[]> {
		if (loaded) return providers;
		return this.refreshProviders();
	},

	async refreshProviders(): Promise<OpenCodeProviderItem[]> {
		try {
			const result = await ws.http('engine:opencode-providers-list', {});
			providers = result.providers;
			loaded = true;
			debug.log('settings', `OpenCode providers loaded: ${providers.length}`);
			return providers;
		} catch {
			providers = [];
			loaded = true;
			return [];
		}
	},

	async addProvider(data: {
		providerId: string;
		name: string;
		npm: string;
		apiUrl?: string;
		options?: string;
		accountName: string;
		apiKey: string;
	}): Promise<OpenCodeProviderItem | null> {
		try {
			const result = await ws.http('engine:opencode-provider-add', data);
			await this.refreshProviders();
			return result.provider;
		} catch (error) {
			debug.error('settings', 'Failed to add OpenCode provider:', error);
			throw error;
		}
	},

	async removeProvider(id: number): Promise<void> {
		await ws.http('engine:opencode-provider-remove', { id });
		await this.refreshProviders();
	},

	async toggleProvider(id: number, enabled: boolean): Promise<void> {
		await ws.http('engine:opencode-provider-toggle', { id, enabled });
		await this.refreshProviders();
	},

	async updateProviderOptions(id: number, options: string): Promise<void> {
		await ws.http('engine:opencode-provider-update-options', { id, options });
		await this.refreshProviders();
	},

	// ========================================================================
	// Accounts
	// ========================================================================

	async addAccount(providerDbId: number, name: string, apiKey: string): Promise<void> {
		await ws.http('engine:opencode-account-add', { providerDbId, name, apiKey });
		await this.refreshProviders();
	},

	async switchAccount(accountId: number): Promise<void> {
		await ws.http('engine:opencode-account-switch', { accountId });
		await this.refreshProviders();
	},

	async deleteAccount(accountId: number): Promise<void> {
		await ws.http('engine:opencode-account-delete', { accountId });
		await this.refreshProviders();
	},

	async renameAccount(accountId: number, name: string): Promise<void> {
		await ws.http('engine:opencode-account-rename', { accountId, name });
		await this.refreshProviders();
	},

	// ========================================================================
	// Models.dev Catalog
	// ========================================================================

	async fetchCatalog(): Promise<ModelsDevProviderItem[]> {
		if (catalogLoaded) return catalog;
		return this.refreshCatalog();
	},

	async refreshCatalog(): Promise<ModelsDevProviderItem[]> {
		try {
			const result = await ws.http('engine:opencode-models-dev-list', {});
			catalog = result.catalog;
			catalogCachedAt = result.cachedAt;
			catalogLoaded = true;
			debug.log('settings', `Models.dev catalog loaded: ${catalog.length} providers`);
			return catalog;
		} catch {
			catalog = [];
			catalogLoaded = true;
			return [];
		}
	},

	async refetchCatalog(): Promise<ModelsDevProviderItem[]> {
		try {
			const result = await ws.http('engine:opencode-models-dev-fetch', {});
			catalog = result.catalog;
			catalogCachedAt = result.cachedAt;
			catalogLoaded = true;
			debug.log('settings', `Models.dev catalog re-fetched: ${catalog.length} providers`);
			return catalog;
		} catch (error) {
			debug.error('settings', 'Failed to re-fetch models.dev catalog:', error);
			throw error;
		}
	},

	// ========================================================================
	// Server Restart
	// ========================================================================

	async restartServer(force = false): Promise<{ success: boolean; activeChats?: number; needsConfirmation?: boolean }> {
		return ws.http('engine:opencode-server-restart', { force });
	},

	// ========================================================================
	// Reset
	// ========================================================================

	reset() {
		providers = [];
		catalog = [];
		catalogCachedAt = null;
		loaded = false;
		catalogLoaded = false;
	}
};
