/**
 * Git Staging Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findNestedRepoPaths, findRepoForFile } from '../../snapshot/gitignore';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string | null {
	if (!repoPath) return null;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectRoot;
	}
	return resolved;
}

export const stagingHandler = createRouter()
	.http('git:stage', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const repo = await findRepoForFile(project.path, data.filePath);
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await gitService.stageFile(cwd, filePath);
		return { ok: true };
	})

	.http('git:stage-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		if (data.repoPath) {
			const cwd = resolveRepoCwd(project.path, data.repoPath) ?? project.path;
			await gitService.stageAll(cwd);
		} else {
			await gitService.stageAll(project.path);
			const nestedRepoPaths = await findNestedRepoPaths(project.path);
			for (const repoPath of nestedRepoPaths) {
				try {
					await gitService.stageAll(repoPath);
				} catch {
					// Skip nested repos whose stage fails
				}
			}
		}
		return { ok: true };
	})

	.http('git:unstage', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const repo = await findRepoForFile(project.path, data.filePath);
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await gitService.unstageFile(cwd, filePath);
		return { ok: true };
	})

	.http('git:unstage-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		if (data.repoPath) {
			const cwd = resolveRepoCwd(project.path, data.repoPath) ?? project.path;
			await gitService.unstageAll(cwd);
		} else {
			await gitService.unstageAll(project.path);
			const nestedRepoPaths = await findNestedRepoPaths(project.path);
			for (const repoPath of nestedRepoPaths) {
				try {
					await gitService.unstageAll(repoPath);
				} catch { /* skip */ }
			}
		}
		return { ok: true };
	})

	.http('git:discard', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const repo = await findRepoForFile(project.path, data.filePath);
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await gitService.discardFile(cwd, filePath);
		return { ok: true };
	})

	.http('git:discard-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		if (data.repoPath) {
			const cwd = resolveRepoCwd(project.path, data.repoPath) ?? project.path;
			await gitService.discardAll(cwd);
		} else {
			await gitService.discardAll(project.path);
			const nestedRepoPaths = await findNestedRepoPaths(project.path);
			for (const repoPath of nestedRepoPaths) {
				try {
					await gitService.discardAll(repoPath);
				} catch { /* skip */ }
			}
		}
		return { ok: true };
	});
