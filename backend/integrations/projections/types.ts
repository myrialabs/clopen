/**
 * Projector contract.
 *
 * A projection is a row on another surface DERIVED from an account. Surfaces
 * never learn that accounts exist: they keep reading their own tables, and a
 * projector is the only thing that writes an integration-owned row into them.
 *
 * One projector per capability. `agent-tools` is the only one that exists
 * today; `database`, `issues`, `deployments`, `worktree-branching` and
 * `notifications` are registered by the tasks that build those surfaces.
 */

import type { IntegrationCapability, IntegrationTargetKind } from '$shared/types/integrations';
import type { IntegrationAccountRow } from '$backend/database/queries';
import type { IntegrationProvider } from '../registry';

export interface ProjectionContext {
	account: IntegrationAccountRow;
	provider: IntegrationProvider;
	/** Decoded credentials. Empty when the active key could not open them. */
	credentials: Record<string, string>;
}

export interface ProjectionResult {
	targetKind: IntegrationTargetKind;
	targetId: string;
	/**
	 * True when the projection took over a row that already existed and was not
	 * created by us. Releasing an adopted row restores it instead of deleting it.
	 */
	adopted: boolean;
	/** Snapshot of the adopted row, stored so release can put it back. */
	restore: unknown | null;
}

export interface Projector {
	capability: IntegrationCapability;
	targetKind: IntegrationTargetKind;
	/** Create or refresh the derived row. Called on connect, credential change and capability enable. */
	project(context: ProjectionContext): ProjectionResult;
	/** Remove the derived row, or hand an adopted one back untouched. */
	release(context: ProjectionContext, targetId: string, adopted: boolean, restore: unknown | null): void;
}
