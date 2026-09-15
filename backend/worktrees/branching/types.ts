/**
 * The contract a worktree-branching provider implements.
 *
 * The worktree manager owns a TABLE (`worktree_branches`), so like DB Client
 * and unlike Issues and Deployments this capability feeds a projection. The
 * adapter's whole job is to turn "this account, this parent database" into an
 * isolated database and a connection string, and to answer the two questions
 * the setup dialog asks: what can this credential reach, and is it working.
 *
 * NOT CALLED "branch" in the copy it produces. Neon cuts a real copy-on-write
 * branch; Turso seeds an entire new database from a parent. Both satisfy this
 * interface, and `info().noun` is what lets the dialog say which one is
 * actually happening instead of calling a seeded database a branch. If a
 * provider needs a second dialog, this interface is wrong and fixing it is the
 * work — the same test `Task 2` and `Task 3` set for their surfaces.
 *
 * Everything a provider knows about its own service stays inside its file, the
 * way `Task 3` kept Vercel's per-endpoint API versions inside the Vercel
 * adapter.
 */

import type {
	BranchParent,
	BranchProviderInfo,
	CreatedBranch,
	RemoteBranch
} from '$shared/types/worktree-branching';
import type { IntegrationStatus } from '$shared/types/integrations';

/** Everything an adapter is given about the account it is acting for. */
export interface BranchProviderContext {
	accountId: string;
	/** Decoded account credentials. Empty when the active key could not open them. */
	credentials: Record<string, string>;
}

export interface BranchProviderAdapter {
	/** Matches the integration provider id, so the brand mark is the same one. */
	provider: string;
	/** How the setup dialog renders this provider. */
	info(): BranchProviderInfo;

	/** Every database this credential can cut branches from. */
	listParents(context: BranchProviderContext): Promise<BranchParent[]>;

	/**
	 * Cut one, and say where it answers.
	 *
	 * `name` is the deterministic name computed by `naming.ts` — the adapter
	 * must use it verbatim where the provider allows, because it is the only
	 * thing tying a leaked branch back to the worktree it belonged to. A
	 * provider that rewrites it (a length cap, a character class) reports what
	 * it actually got as `CreatedBranch.name`.
	 *
	 * The returned connection carries a PASSWORD. It is sealed the moment it
	 * reaches `worktree_branches` and is never handed to the client.
	 */
	createBranch(
		context: BranchProviderContext,
		input: { parentRef: string; name: string; pooled: boolean }
	): Promise<CreatedBranch>;

	/**
	 * Destroy one.
	 *
	 * Must be IDEMPOTENT in the direction that matters: a branch that is already
	 * gone is a success, not an error. The caller reaches here while deleting a
	 * worktree, and turning "it was already deleted" into a failure would mark a
	 * perfectly clean deletion as a leaked branch and put it in the orphan list
	 * forever.
	 */
	deleteBranch(
		context: BranchProviderContext,
		input: { parentRef: string; branchRef: string }
	): Promise<void>;

	/**
	 * Every branch that exists at the provider right now.
	 *
	 * Used by the orphan sweep, which is the half of leak detection that a local
	 * table cannot do: a crash between "the provider created it" and "the row was
	 * written" leaves a branch nothing here knows about.
	 */
	listBranches(context: BranchProviderContext, parentRef: string): Promise<RemoteBranch[]>;

	/** Health of the credential itself, for the hub's status strip. */
	probe(context: BranchProviderContext): Promise<{ status: IntegrationStatus; detail: string | null }>;
}
