/**
 * Git Branch Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

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
		operation: t.Optional(t.Union([t.String(), t.Null()]))
	}),
	error: t.Optional(t.String())
});

/**
 * Resolve the working directory for a git operation. Defaults to the project
 * root; when `repoPath` is provided it must already be inside the project
 * (these paths come from the backend's own `getBranches` response, but we
 * re-validate to defend against a tampered/mismatched client).
 */
function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string {
	if (!repoPath) return projectPath;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	// Must equal project root or live strictly inside it — no `..` escape.
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectPath;
	}
	return resolved;
}

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
			nested: t.Optional(t.Array(NestedRepoInfoSchema))
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.getBranches(project.path, data.selectedRemote);
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
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.createBranch(cwd, data.name, data.startPoint);
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
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.switchBranch(cwd, data.name);
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
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.checkoutCommit(cwd, data.commitHash);
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
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.deleteBranch(cwd, data.name, data.force);
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
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.renameBranch(cwd, data.oldName, data.newName);
		return { ok: true };
	})

	.http('git:merge-branch', {
		data: t.Object({
			projectId: t.String(),
			branchName: t.String(),
			noFastForward: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.mergeBranch(cwd, data.branchName, data.noFastForward ?? false);
	});
