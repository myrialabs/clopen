/**
 * Adapter registry for worktree database branching.
 *
 * Deliberately dumb, and deliberately the same shape as the Issues, Deployments
 * and DB Client registries: a map from provider id to adapter, filled at module
 * load. Adding Turso is one file in `providers/` plus one line in `index.ts` —
 * one thing to learn rather than four.
 */

import type { BranchProviderAdapter } from './types';

const adapters = new Map<string, BranchProviderAdapter>();

export function registerBranchProvider(adapter: BranchProviderAdapter): void {
	if (adapters.has(adapter.provider)) {
		throw new Error(`A branch adapter for "${adapter.provider}" is already registered`);
	}
	adapters.set(adapter.provider, adapter);
}

export function getBranchProvider(provider: string): BranchProviderAdapter | null {
	return adapters.get(provider) ?? null;
}

export function listBranchProviders(): BranchProviderAdapter[] {
	return [...adapters.values()];
}
