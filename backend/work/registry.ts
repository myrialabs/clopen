/**
 * Adapter registry for the Issues & PRs surface.
 *
 * Deliberately dumb: a map from provider id to adapter, filled at module load.
 * Adding GitLab is one file in `providers/` plus one line in `index.ts` — the
 * same shape as the internal-MCP `defineServer()` pattern and the integration
 * provider registry, so there is one thing to learn rather than three.
 */

import type { WorkProviderAdapter } from './types';

const adapters = new Map<string, WorkProviderAdapter>();

export function registerWorkProvider(adapter: WorkProviderAdapter): void {
	if (adapters.has(adapter.provider)) {
		throw new Error(`An issue adapter for "${adapter.provider}" is already registered`);
	}
	adapters.set(adapter.provider, adapter);
}

export function getWorkAdapter(provider: string): WorkProviderAdapter | null {
	return adapters.get(provider) ?? null;
}

export function listWorkAdapters(): WorkProviderAdapter[] {
	return [...adapters.values()];
}
