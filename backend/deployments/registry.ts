/**
 * Adapter registry for the Deployments surface.
 *
 * Deliberately dumb: a map from provider id to adapter, filled at module load.
 * Adding Netlify is one directory in `providers/` plus one line in `index.ts` —
 * the same shape as the Issues registry and the internal-MCP `defineServer()`
 * pattern, so there is one thing to learn rather than three.
 */

import type { DeployProviderAdapter } from './types';

const adapters = new Map<string, DeployProviderAdapter>();

export function registerDeployProvider(adapter: DeployProviderAdapter): void {
	if (adapters.has(adapter.provider)) {
		throw new Error(`A deploy adapter for "${adapter.provider}" is already registered`);
	}
	adapters.set(adapter.provider, adapter);
}

export function getDeployAdapter(provider: string): DeployProviderAdapter | null {
	return adapters.get(provider) ?? null;
}

export function listDeployAdapters(): DeployProviderAdapter[] {
	return [...adapters.values()];
}
