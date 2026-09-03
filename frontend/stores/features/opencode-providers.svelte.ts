/**
 * OpenCode Providers Store
 *
 * Shared reactive store for OpenCode provider + account management.
 * Used by AIEnginesSettings to display and manage providers.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { createCachedLoad } from '$frontend/stores/utils/cached-load.svelte';

export interface OpenCodeAccountItem {
	id: number;
	name: string;
	isActive: boolean;
	createdAt: string;
}

export interface OpenCodeProviderItem {
	id: number;
	slug: string;
	name: string;
	npm: string | null;
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
const providersCache = createCachedLoad('OpenCode providers');
const catalogCache = createCachedLoad('Models.dev catalog');

export const opencodeProvidersStore = {
	get providers() { return providers; },
	get catalog() { return catalog; },
	get catalogCachedAt() { return catalogCachedAt; },
	get loaded() { return providersCache.loaded; },
	get catalogLoaded() { return catalogCache.loaded; },

	// ========================================================================
	// Providers
	// ========================================================================

	async fetchProviders(): Promise<OpenCodeProviderItem[]> {
		await providersCache.ensure(loadProviders);
		return providers;
	},

	async refreshProviders(): Promise<OpenCodeProviderItem[]> {
		await providersCache.refresh(loadProviders);
		return providers;
	},

	async addProvider(data: {
		slug: string;
		name: string;
		npm?: string | null;
		apiUrl?: string;
		options?: string;
		accountName: string;
		credential: string;
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

	async updateProvider(id: number, data: {
		slug?: string;
		name?: string;
		apiUrl?: string;
		options?: string;
	}): Promise<void> {
		await ws.http('engine:opencode-provider-update', { id, ...data });
		await this.refreshProviders();
	},

	async updateProviderOptions(id: number, options: string): Promise<void> {
		await ws.http('engine:opencode-provider-update-options', { id, options });
		await this.refreshProviders();
	},

	// ========================================================================
	// Accounts
	// ========================================================================

	async addAccount(providerDbId: number, name: string, credential: string): Promise<void> {
		await ws.http('engine:opencode-account-add', { providerDbId, name, credential });
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

	async updateAccountCredential(accountId: number, credential: string): Promise<void> {
		await ws.http('engine:opencode-account-update-credential', { accountId, credential });
		await this.refreshProviders();
	},

	// ========================================================================
	// Models.dev Catalog
	// ========================================================================

	async fetchCatalog(): Promise<ModelsDevProviderItem[]> {
		await catalogCache.ensure(loadCatalog);
		return catalog;
	},

	async refreshCatalog(): Promise<ModelsDevProviderItem[]> {
		await catalogCache.refresh(loadCatalog);
		return catalog;
	},

	/**
	 * Ask the backend to go back to models.dev rather than serve its cache.
	 *
	 * Unlike the two above this one still throws: it is only ever reached from an
	 * explicit "refresh catalog" button, and a user who pressed it is owed an
	 * error rather than a list that quietly did not change.
	 */
	async refetchCatalog(): Promise<ModelsDevProviderItem[]> {
		try {
			const result = await ws.http('engine:opencode-models-dev-fetch', {});
			catalog = result.catalog;
			catalogCachedAt = result.cachedAt;
			catalogCache.markLoaded();
			debug.log('settings', `Models.dev catalog re-fetched: ${catalog.length} providers`);
			return catalog;
		} catch (error) {
			debug.error('settings', 'Failed to re-fetch models.dev catalog:', error);
			throw error;
		}
	},

	// ========================================================================
	// Reset
	// ========================================================================

	reset() {
		providers = [];
		catalog = [];
		catalogCachedAt = null;
		providersCache.reset();
		catalogCache.reset();
	}
};

/**
 * The two requests behind this store. Neither catches — see the note in
 * `createCachedLoad`: a failed load must not be cached as an empty list, or the
 * Engines settings would show "no providers" for the rest of the session with no
 * way back short of a reload.
 */
async function loadProviders(): Promise<void> {
	const result = await ws.http('engine:opencode-providers-list', {});
	providers = result.providers;
	debug.log('settings', `OpenCode providers loaded: ${providers.length}`);
}

async function loadCatalog(): Promise<void> {
	const result = await ws.http('engine:opencode-models-dev-list', {});
	catalog = result.catalog;
	catalogCachedAt = result.cachedAt;
	debug.log('settings', `Models.dev catalog loaded: ${catalog.length} providers`);
}
