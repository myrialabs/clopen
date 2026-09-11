/**
 * Projector registry and the re-projection pass.
 *
 * `reproject()` is the single entry point every mutation goes through —
 * connect, credential change, capability toggle, enable/disable, disconnect.
 * Having one pass rather than four call sites is what keeps "projections are
 * derived" true: there is no path that changes an account without the surfaces
 * being recomputed from it.
 */

import { integrationAccountQueries, integrationProjectionQueries } from '$backend/database/queries';
import type { IntegrationAccountRow } from '$backend/database/queries';
import type { IntegrationCapability } from '$shared/types/integrations';
import { getProvider } from '../registry';
import { mcpProjector } from './mcp-projector';
import type { Projector, ProjectionContext } from './types';
import { debug } from '$shared/utils/logger';

export type { Projector, ProjectionContext, ProjectionResult } from './types';

/**
 * One projector per capability that has a surface to project onto.
 *
 * A capability a provider declares but that has no projector here simply does
 * not project — the account still records it, so the surface that lands later
 * finds its accounts already connected.
 */
const PROJECTORS: Projector[] = [mcpProjector];

const byCapability = new Map(PROJECTORS.map((projector) => [projector.capability, projector]));

/** Register a projector from the surface that owns it. Called at module load. */
export function registerProjector(projector: Projector): void {
	if (byCapability.has(projector.capability)) {
		throw new Error(`A projector for "${projector.capability}" is already registered`);
	}
	byCapability.set(projector.capability, projector);
	PROJECTORS.push(projector);
}

function contextFor(account: IntegrationAccountRow): ProjectionContext | null {
	const provider = getProvider(account.provider);
	if (!provider) {
		debug.warn('integrations', `Account ${account.id} references unknown provider "${account.provider}"`);
		return null;
	}
	return {
		account,
		provider,
		credentials: integrationAccountQueries.credentialsOf(account)
	};
}

/**
 * Recompute every surface row this account owns.
 *
 * `wanted` is the set of capabilities that should be projected right now: the
 * account's enabled capabilities, or nothing at all when the account is
 * disabled. Anything projected that is not wanted gets released, which is how a
 * capability toggle and a disconnect end up being the same operation.
 */
export function reproject(accountId: string, options: { releaseAll?: boolean } = {}): void {
	const account = integrationAccountQueries.getById(accountId);
	if (!account) return;

	const context = contextFor(account);
	if (!context) return;

	const wanted: Set<IntegrationCapability> = options.releaseAll || account.is_enabled !== 1
		? new Set()
		: new Set(integrationAccountQueries.capabilitiesOf(account));

	const current = integrationProjectionQueries.getForAccount(accountId);

	// Release first. A capability turned off and a slug moved to another
	// provider both look like "this projection is no longer wanted", and doing
	// the releases before the projections keeps a slug from colliding with its
	// own stale row.
	for (const row of current) {
		if (wanted.has(row.capability)) continue;
		const projector = byCapability.get(row.capability);
		if (projector) {
			try {
				projector.release(context, row.target_id, row.adopted === 1, integrationProjectionQueries.restoreOf(row));
			} catch (error) {
				debug.error('integrations', `Failed to release ${row.capability} for account ${accountId}:`, error);
			}
		}
		integrationProjectionQueries.remove(accountId, row.capability, row.target_kind);
	}

	for (const capability of wanted) {
		const projector = byCapability.get(capability);
		if (!projector) continue;
		try {
			const result = projector.project(context);
			integrationProjectionQueries.upsert({
				accountId,
				capability,
				targetKind: result.targetKind,
				targetId: result.targetId,
				adopted: result.adopted,
				restore: result.restore
			});
		} catch (error) {
			debug.error('integrations', `Failed to project ${capability} for account ${accountId}:`, error);
			throw error;
		}
	}
}

/** Release everything this account owns. Called immediately before deleting it. */
export function releaseAll(accountId: string): void {
	reproject(accountId, { releaseAll: true });
}

/** Capabilities that currently have a surface to project onto. */
export function projectableCapabilities(): IntegrationCapability[] {
	return [...byCapability.keys()];
}
