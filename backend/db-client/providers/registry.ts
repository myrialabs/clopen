/**
 * Adapter registry for account-backed database connections.
 *
 * Deliberately dumb, and deliberately the same shape as the Issues and
 * Deployments registries: a map from provider id to adapter, filled at module
 * load. Adding Turso is one directory in `providers/` plus one line in
 * `backend/db-client/integrations/index.ts`.
 */

import type { DbProviderAdapter } from './types';

const adapters = new Map<string, DbProviderAdapter>();

export function registerDbProvider(adapter: DbProviderAdapter): void {
	if (adapters.has(adapter.provider)) {
		throw new Error(`A database adapter for "${adapter.provider}" is already registered`);
	}
	adapters.set(adapter.provider, adapter);
}

export function getDbProvider(provider: string): DbProviderAdapter | null {
	return adapters.get(provider) ?? null;
}

export function listDbProviders(): DbProviderAdapter[] {
	return [...adapters.values()];
}
