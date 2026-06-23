/**
 * Git Commit Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

/**
 * Resolve the working directory for a git operation. Defaults to the project
 * root; when `repoPath` is provided it must already be inside the project.
 */
function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string {
	if (!repoPath) return projectPath;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectPath;
	}
	return resolved;
}

export const commitHandler = createRouter()
	.http('git:commit', {
		data: t.Object({
			projectId: t.String(),
			message: t.String({ minLength: 1 }),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			hash: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const hash = await gitService.commit(cwd, data.message);
		return { hash };
	})

	.http('git:amend', {
		data: t.Object({
			projectId: t.String(),
			message: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			hash: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const hash = await gitService.amendCommit(cwd, data.message);
		return { hash };
	})

	.http('git:undo-commit', {
		data: t.Object({
			projectId: t.String(),
			mode: t.Union([t.Literal('soft'), t.Literal('mixed'), t.Literal('hard')]),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.undoLastCommit(cwd, data.mode);
		return { ok: true };
	})

	.http('git:revert', {
		data: t.Object({
			projectId: t.String(),
			ref: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.revertCommit(cwd, data.ref);
	})

	.http('git:cherry-pick', {
		data: t.Object({
			projectId: t.String(),
			hashes: t.Array(t.String(), { minItems: 1 }),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.cherryPick(cwd, data.hashes);
	})

	.http('git:clean', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const message = await gitService.cleanUntracked(cwd);
		return { message };
	})

	.http('git:gc', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const message = await gitService.optimize(cwd);
		return { message };
	})

	.http('git:npm-version', {
		data: t.Object({
			projectId: t.String(),
			bump: t.Union([t.Literal('patch'), t.Literal('minor'), t.Literal('major')]),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			version: t.String(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.npmVersion(cwd, data.bump);
	});
