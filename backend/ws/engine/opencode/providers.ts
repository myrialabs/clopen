/**
 * OpenCode Provider Management Handlers
 *
 * CRUD for providers and accounts, models.dev catalog, and server restart.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import {
	fetchAndCacheModelsDevCatalog,
	getCachedModelsDevCatalog,
} from '../../../engine/adapters/opencode/presets';
import { disposeOpenCodeClient } from '../../../engine/adapters/opencode/server';
import { disposeEngine } from '../../../engine';
import { streamManager } from '../../../chat';
import { debug } from '$shared/utils/logger';

// Shared typebox schemas
const AccountSchema = t.Object({
	id: t.Number(),
	name: t.String(),
	isActive: t.Boolean(),
	createdAt: t.String(),
});

const ProviderSchema = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	npm: t.Union([t.String(), t.Null()]),
	apiUrl: t.Union([t.String(), t.Null()]),
	options: t.String(),
	isEnabled: t.Boolean(),
	createdAt: t.String(),
	accounts: t.Array(AccountSchema),
});

export const openCodeProviderHandler = createRouter()

	// ═══════════════════════════════════════
	// Provider CRUD
	// ═══════════════════════════════════════

	.http('engine:opencode-providers-list', {
		data: t.Object({}),
		response: t.Object({
			providers: t.Array(ProviderSchema)
		})
	}, async () => {
		const providers = engineQueries.getProvidersWithAccounts('opencode');
		return {
			providers: providers.map(p => ({
				id: p.id,
				slug: p.slug,
				name: p.name,
				npm: p.npm,
				apiUrl: p.api_url,
				options: p.options,
				isEnabled: p.is_enabled === 1,
				createdAt: p.created_at,
				accounts: p.accounts.map(a => ({
					id: a.id,
					name: a.name,
					isActive: a.is_active === 1,
					createdAt: a.created_at,
				})),
			}))
		};
	})

	.http('engine:opencode-provider-add', {
		data: t.Object({
			slug: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			npm: t.Optional(t.Union([t.String(), t.Null()])),
			apiUrl: t.Optional(t.String()),
			options: t.Optional(t.String()),
			accountName: t.String({ minLength: 1 }),
			credential: t.String({ minLength: 1 }),
		}),
		response: t.Object({
			provider: ProviderSchema
		})
	}, async ({ data }) => {
		// Check if provider already exists
		const existing = engineQueries.getProviderBySlug('opencode', data.slug);
		if (existing) {
			throw new Error(`Provider "${data.slug}" already configured`);
		}

		// Create provider
		const provider = engineQueries.createProvider({
			engineType: 'opencode',
			slug: data.slug,
			name: data.name,
			npm: data.npm ?? undefined,
			apiUrl: data.apiUrl,
			options: data.options,
		});

		// Create first account (auto-active)
		const account = engineQueries.createAccount(provider.id, data.accountName, data.credential);

		debug.log('engine', `OpenCode provider added: ${data.slug} with account "${data.accountName}"`);

		return {
			provider: {
				id: provider.id,
				slug: provider.slug,
				name: provider.name,
				npm: provider.npm,
				apiUrl: provider.api_url,
				options: provider.options,
				isEnabled: provider.is_enabled === 1,
				createdAt: provider.created_at,
				accounts: [{
					id: account.id,
					name: account.name,
					isActive: account.is_active === 1,
					createdAt: account.created_at,
				}],
			}
		};
	})

	.http('engine:opencode-provider-remove', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.deleteProvider(data.id);
		debug.log('engine', `OpenCode provider removed: ${data.id}`);
		return { success: true };
	})

	.http('engine:opencode-provider-update', {
		data: t.Object({
			id: t.Number(),
			name: t.Optional(t.String()),
			apiUrl: t.Optional(t.String()),
			options: t.Optional(t.String()),
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		if (data.options !== undefined) {
			try { JSON.parse(data.options); } catch { throw new Error('Invalid JSON for options'); }
		}
		engineQueries.updateProvider(data.id, {
			name: data.name,
			apiUrl: data.apiUrl,
			options: data.options,
		});
		return { success: true };
	})

	.http('engine:opencode-provider-toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.toggleProvider(data.id, data.enabled);
		return { success: true };
	})

	.http('engine:opencode-provider-update-options', {
		data: t.Object({ id: t.Number(), options: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		// Validate JSON
		try { JSON.parse(data.options); } catch { throw new Error('Invalid JSON for options'); }
		engineQueries.updateProviderOptions(data.id, data.options);
		return { success: true };
	})

	// ═══════════════════════════════════════
	// Account CRUD
	// ═══════════════════════════════════════

	.http('engine:opencode-account-add', {
		data: t.Object({
			providerDbId: t.Number(),
			name: t.String({ minLength: 1 }),
			credential: t.String({ minLength: 1 }),
		}),
		response: t.Object({
			account: AccountSchema
		})
	}, async ({ data }) => {
		const account = engineQueries.createAccount(data.providerDbId, data.name, data.credential);
		debug.log('engine', `OpenCode account added: "${data.name}" for provider ${data.providerDbId}`);
		return {
			account: {
				id: account.id,
				name: account.name,
				isActive: account.is_active === 1,
				createdAt: account.created_at,
			}
		};
	})

	.http('engine:opencode-account-switch', {
		data: t.Object({ accountId: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.accountId);
		return { success: true };
	})

	.http('engine:opencode-account-delete', {
		data: t.Object({ accountId: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.deleteAccount(data.accountId);
		return { success: true };
	})

	.http('engine:opencode-account-rename', {
		data: t.Object({ accountId: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.accountId, data.name);
		return { success: true };
	})

	// ═══════════════════════════════════════
	// Models.dev Catalog
	// ═══════════════════════════════════════

	.http('engine:opencode-models-dev-list', {
		data: t.Object({}),
		response: t.Object({
			catalog: t.Array(t.Object({
				id: t.String(),
				name: t.String(),
				npm: t.String(),
				env: t.Array(t.String()),
				api: t.Union([t.String(), t.Null()]),
			})),
			cachedAt: t.Union([t.String(), t.Null()]),
		})
	}, async () => {
		const cached = getCachedModelsDevCatalog();
		if (cached) {
			return { catalog: cached.catalog, cachedAt: cached.cachedAt };
		}

		// First time: fetch and cache
		try {
			const catalog = await fetchAndCacheModelsDevCatalog();
			return { catalog, cachedAt: new Date().toISOString() };
		} catch (error) {
			debug.error('engine', 'Failed to fetch models.dev catalog:', error);
			return { catalog: [], cachedAt: null };
		}
	})

	.http('engine:opencode-models-dev-fetch', {
		data: t.Object({}),
		response: t.Object({
			catalog: t.Array(t.Object({
				id: t.String(),
				name: t.String(),
				npm: t.String(),
				env: t.Array(t.String()),
				api: t.Union([t.String(), t.Null()]),
			})),
			cachedAt: t.String(),
		})
	}, async () => {
		const catalog = await fetchAndCacheModelsDevCatalog();
		return { catalog, cachedAt: new Date().toISOString() };
	})

	// ═══════════════════════════════════════
	// Model Discovery
	// ═══════════════════════════════════════

	.http('engine:opencode-provider-fetch-models', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({
			models: t.Array(t.Object({ id: t.String(), name: t.Optional(t.String()) }))
		})
	}, async ({ data }) => {
		const providers = engineQueries.getProvidersWithAccounts('opencode');
		const provider = providers.find(p => p.id === data.id);
		if (!provider) throw new Error('Provider not found');
		if (!provider.api_url) throw new Error('Provider has no API URL');

		const baseUrl = provider.api_url.replace(/\/+$/, '');
		const activeAccount = provider.accounts.find(a => a.is_active === 1) || provider.accounts[0];
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (activeAccount?.credential) {
			headers['Authorization'] = `Bearer ${activeAccount.credential}`;
		}

		const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json() as { data?: { id: string; name?: string }[] };
		const models = (body.data || []).map(m => ({ id: m.id, name: m.name }));
		return { models };
	})

	// ═══════════════════════════════════════
	// Server Restart
	// ═══════════════════════════════════════

	.http('engine:opencode-server-restart', {
		data: t.Object({
			force: t.Optional(t.Boolean()),
		}),
		response: t.Object({
			success: t.Boolean(),
			activeChats: t.Optional(t.Number()),
			needsConfirmation: t.Optional(t.Boolean()),
		})
	}, async ({ data }) => {
		// Check for active opencode streams
		const activeStreams = streamManager.getActiveStreams()
			.filter(s => s.engine === 'opencode');

		if (activeStreams.length > 0 && !data.force) {
			return {
				success: false,
				activeChats: activeStreams.length,
				needsConfirmation: true,
			};
		}

		// Force: abort all active opencode streams first
		if (activeStreams.length > 0) {
			debug.log('engine', `Force-aborting ${activeStreams.length} active OpenCode streams before restart`);
			for (const stream of activeStreams) {
				try {
					await streamManager.cancelStream(stream.streamId);
				} catch (error) {
					debug.warn('engine', `Failed to abort stream ${stream.streamId}:`, error);
				}
			}
		}

		// Dispose global opencode engine + shared client/server.
		// forRestart=true ensures the server is killed even if we didn't
		// spawn it, and the stored URL is purged so next init() spawns fresh.
		await disposeEngine('opencode');
		await disposeOpenCodeClient(true);

		debug.log('engine', 'OpenCode server disposed. Will re-initialize on next use.');

		return { success: true };
	});
