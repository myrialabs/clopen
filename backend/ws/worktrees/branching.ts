/**
 * Worktree database branching routes.
 *
 *   worktrees:branching-state    sources, binding, dotenv files, branches
 *   worktrees:branch-suggest     the binding this project's own `.env` implies
 *   worktrees:branch-parents     databases one source can copy from
 *   worktrees:branching-save     point this project at a parent database
 *   worktrees:branching-clear    stop branching — existing branches are left alone
 *   worktrees:branch-rewrite-env retry the dotenv write
 *   worktrees:branch-orphans     branches with no live worktree, both kinds
 *   worktrees:branch-delete      destroy an orphan at the provider
 *   worktrees:branch-forget      drop the row, leave the remote branch alone
 *   worktrees:branch-delete-remote  destroy a branch the sweep found untracked
 *
 * ACCESS IS SPLIT, deliberately, and enforced in two places. Every route here
 * takes project access the way `worktrees:create` and `git:push` do — they act
 * inside one project. The DESTROYING ones are additionally listed in
 * `backend/auth/permissions.ts` as admin-only, the way `db-client:link` is:
 * deleting one destroys a real database.
 *
 * Choosing a SOURCE is gated per source rather than per route, because the two
 * kinds belong to different people. An integration account belongs to the
 * install and spends its quota, so only an admin is shown one; a DB Client
 * connection belongs to whoever saved it, and refusing a member their own would
 * make the whole feature admin-only for no reason that survives being stated.
 * `listBranchSources` decides, and `requireSource` enforces.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { worktreeBranching } from '../../worktrees';
import { ws } from '$backend/utils/ws';
import { requireCurrentProjectAccess } from '../access';

/**
 * Who is asking.
 *
 * Passed into every source-facing call rather than checked here, because the
 * rule is not "admin or not": an integration account belongs to the install and
 * is admin-only, while a DB Client connection belongs to whoever saved it. One
 * helper in the service answers both — see `requireSource`.
 */
function principalOf(conn: Parameters<typeof ws.getUserId>[0]) {
	return { userId: ws.getUserId(conn), isAdmin: ws.getRole(conn) === 'admin' };
}

/**
 * Tell everyone in the project that its branches or binding moved.
 *
 * The broadcast state is built for an ADMIN. Every recipient re-reads the
 * source list through their own request anyway, and building one payload per
 * viewer here would make an announcement O(viewers) round trips into the
 * database for a list that is about to be refetched.
 */
async function announce(projectId: string): Promise<void> {
	ws.emit.project(projectId, 'worktrees:branching-changed', {
		projectId,
		state: await worktreeBranching.state(projectId, { userId: '', isAdmin: true })
	});
}

export const worktreeBranchingHandler = createRouter()
	.http('worktrees:branching-state', {
		data: t.Object({}),
		response: t.Any()
	}, async ({ conn }) => {
		await initializeDatabase();
		const { projectId } = requireCurrentProjectAccess(conn);
		return worktreeBranching.state(projectId, principalOf(conn));
	})

	/**
	 * The binding this project would get if it asked for one.
	 *
	 * Its own route rather than a field on `branching-state`, because it reads
	 * the project's dotenv files from disk and the state route is on the path of
	 * every worktree dialog open.
	 */
	.http('worktrees:branch-suggest', {
		data: t.Object({}),
		response: t.Nullable(t.Any())
	}, async ({ conn }) => {
		await initializeDatabase();
		const { projectId } = requireCurrentProjectAccess(conn);
		return worktreeBranching.suggest(projectId);
	})

	.http('worktrees:branch-parents', {
		data: t.Object({
			sourceKind: t.Union([t.Literal('account'), t.Literal('connection')]),
			sourceId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireCurrentProjectAccess(conn);
		return worktreeBranching.parents(data, principalOf(conn));
	})

	.http('worktrees:branching-save', {
		data: t.Object({
			sourceKind: t.Union([t.Literal('account'), t.Literal('connection')]),
			sourceId: t.String({ minLength: 1 }),
			parentRef: t.String({ minLength: 1 }),
			parentName: t.String(),
			config: t.Object({
				envVar: t.Optional(t.String()),
				envFile: t.Optional(t.String()),
				autoCreate: t.Optional(t.Boolean()),
				pooled: t.Optional(t.Boolean()),
				dataMode: t.Optional(
					t.Union([t.Literal('schema-data'), t.Literal('schema'), t.Literal('empty')])
				)
			})
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		await initializeDatabase();
		const { projectId } = requireCurrentProjectAccess(conn);

		const binding = worktreeBranching.saveBinding({ projectId, ...data }, principalOf(conn));
		await announce(projectId);
		return binding;
	})

	.http('worktrees:branching-clear', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);

		worktreeBranching.clearBinding(projectId);
		await announce(projectId);
		return { success: true };
	})

	.http('worktrees:branch-rewrite-env', {
		data: t.Object({ branchId: t.String({ minLength: 1 }) }),
		response: t.Nullable(t.Any())
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		const branch = await worktreeBranching.rewriteEnv(data.branchId);
		await announce(projectId);
		return branch;
	})

	/**
	 * Both kinds of leak in one answer.
	 *
	 * Tracked orphans come from the database and always succeed. The remote sweep
	 * talks to the provider and can fail, so it is reported as `sweepError`
	 * rather than taking the whole route down with it: a list that says "no
	 * untracked branches" because it could not look is exactly the false
	 * reassurance this feature exists to avoid.
	 */
	.http('worktrees:branch-orphans', {
		data: t.Object({}),
		response: t.Object({
			tracked: t.Array(t.Any()),
			untracked: t.Array(t.Any()),
			sweepError: t.Nullable(t.String())
		})
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);

		let untracked: unknown[] = [];
		let sweepError: string | null = null;
		try {
			untracked = await worktreeBranching.unknownBranches(projectId);
		} catch (error) {
			sweepError = error instanceof Error ? error.message : String(error);
		}

		return { tracked: worktreeBranching.orphans(), untracked, sweepError };
	})

	.http('worktrees:branch-delete', {
		data: t.Object({ branchId: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);

		await worktreeBranching.deleteOrphan(data.branchId);
		await announce(projectId);
		return { success: true };
	})

	.http('worktrees:branch-forget', {
		data: t.Object({ branchId: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);

		worktreeBranching.forgetOrphan(data.branchId);
		await announce(projectId);
		return { success: true };
	})

	.http('worktrees:branch-delete-remote', {
		data: t.Object({
			sourceKind: t.Union([t.Literal('account'), t.Literal('connection')]),
			sourceId: t.String({ minLength: 1 }),
			parentRef: t.String({ minLength: 1 }),
			branchRef: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		requireCurrentProjectAccess(conn);

		await worktreeBranching.deleteUnknown(data);
		return { success: true };
	});
