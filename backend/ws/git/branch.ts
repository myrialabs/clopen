/**
 * Git Branch Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectWorkspace } from '../access';
import { identityEnvFor } from './identity-context';
import { gitRepoContext, withRepoLock } from './repo-context';

const BranchSchema = t.Object({
	name: t.String(),
	isCurrent: t.Boolean(),
	isRemote: t.Boolean(),
	upstream: t.Optional(t.String()),
	ahead: t.Number(),
	behind: t.Number(),
	lastCommit: t.Optional(t.String())
});

/** Subset of GitNestedRepoInfo we expose to the client (mirrors shared type). */
const NestedRepoInfoSchema = t.Object({
	path: t.String(),
	relPath: t.String(),
	isSubmodule: t.Boolean(),
	info: t.Object({
		current: t.String(),
		local: t.Array(BranchSchema),
		remote: t.Array(BranchSchema),
		ahead: t.Number(),
		behind: t.Number(),
		detached: t.Optional(t.Boolean()),
		operation: t.Optional(t.Union([t.String(), t.Null()])),
		hasSubmodules: t.Optional(t.Boolean()),
		hasPackageJson: t.Optional(t.Boolean())
	}),
	error: t.Optional(t.String())
});

export const branchHandler = createRouter()
	.http('git:branches', {
		data: t.Object({
			projectId: t.String(),
			selectedRemote: t.Optional(t.String())
		}),
		response: t.Object({
			current: t.String(),
			local: t.Array(BranchSchema),
			remote: t.Array(BranchSchema),
			ahead: t.Number(),
			behind: t.Number(),
			detached: t.Optional(t.Boolean()),
			operation: t.Optional(t.Union([t.String(), t.Null()])),
			nested: t.Optional(t.Array(NestedRepoInfoSchema)),
			hasSubmodules: t.Optional(t.Boolean()),
			hasPackageJson: t.Optional(t.Boolean())
		})
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		return await gitService.getBranches(root, data.selectedRemote);
	})

	.http('git:create-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String({ minLength: 1 }),
			startPoint: t.Optional(t.String()),
			/** Absolute path of a nested repo inside the project (e.g. "packages/web").
			 *  Defaults to the outer repo when omitted. */
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'branch', label: 'Create branch', target: data.name }, () =>
			gitService.createBranch(ctx.cwd, data.name, data.startPoint)
		);
		return { ok: true };
	})

	.http('git:switch-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			/** Absolute path of a nested repo inside the project. */
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'branch', label: 'Switch branch', target: data.name }, () =>
			gitService.switchBranch(ctx.cwd, data.name)
		);
		return { ok: true };
	})

	.http('git:checkout-commit', {
		data: t.Object({
			projectId: t.String(),
			commitHash: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'branch', label: 'Checkout commit', target: data.commitHash.slice(0, 7) }, () =>
			gitService.checkoutCommit(ctx.cwd, data.commitHash)
		);
		return { ok: true };
	})

	.http('git:delete-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			force: t.Optional(t.Boolean()),
			/** Absolute path of a nested repo inside the project. */
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'branch', label: 'Delete branch', target: data.name }, () =>
			gitService.deleteBranch(ctx.cwd, data.name, data.force)
		);
		return { ok: true };
	})

	.http('git:rename-branch', {
		data: t.Object({
			projectId: t.String(),
			oldName: t.String(),
			newName: t.String({ minLength: 1 }),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'branch', label: 'Rename branch', target: data.oldName }, () =>
			gitService.renameBranch(ctx.cwd, data.oldName, data.newName)
		);
		return { ok: true };
	})

	.http('git:merge-branch', {
		data: t.Object({
			projectId: t.String(),
			branchName: t.String(),
			noFastForward: t.Optional(t.Boolean()),
			/** Collapse the branch into staged changes without committing. */
			squash: t.Optional(t.Boolean()),
			/** Refuse the merge unless it is a fast-forward. */
			ffOnly: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'more', label: 'Merge', target: data.branchName }, () =>
			gitService.mergeBranch(
				ctx.cwd,
				data.branchName,
				{
					noFastForward: data.noFastForward ?? false,
					squash: data.squash ?? false,
					ffOnly: data.ffOnly ?? false
				},
				identityEnvFor(data.projectId)
			)
		);
	})

	.http('git:rebase', {
		data: t.Object({
			projectId: t.String(),
			upstream: t.String({ minLength: 1 }),
			/** Stash and restore local changes around the rebase. Defaults to true. */
			autostash: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			hasConflicts: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'more', label: 'Rebase', target: data.upstream }, () =>
			gitService.rebaseOnto(ctx.cwd, data.upstream, data.autostash ?? true, identityEnvFor(data.projectId))
		);
	})

	.http('git:return-to-branch', {
		data: t.Object({
			projectId: t.String(),
			/** Explicit target; omit to use git's own "previous checkout" shorthand. */
			branch: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'more', label: 'Return to branch' }, () =>
			gitService.returnToBranch(ctx.cwd, data.branch)
		);
		return { ok: true };
	})

	// Branches a prune would delete, for the confirmation list.
	.http('git:prune-candidates', {
		data: t.Object({
			projectId: t.String(),
			mode: t.Union([t.Literal('merged'), t.Literal('gone')]),
			remote: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			defaultBranch: t.Union([t.String(), t.Null()]),
			candidates: t.Array(t.Object({ name: t.String(), merged: t.Boolean() }))
		})
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await gitService.getPruneCandidates(ctx.cwd, data.mode, data.remote);
	})

	.http('git:delete-branches', {
		data: t.Object({
			projectId: t.String(),
			names: t.Array(t.String(), { minItems: 1 }),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			deleted: t.Array(t.String()),
			failed: t.Array(t.Object({ name: t.String(), message: t.String() }))
		})
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'branch', label: 'Prune branches' }, () =>
			gitService.deleteBranches(ctx.cwd, data.names)
		);
	});
