/**
 * Git Staging Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findRepoForFile } from '../../git/nested-repos';
import { requireProjectWorkspace } from '../access';
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
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const repo = await findRepoForFile(root, data.filePath);
		const cwd = repo?.repoPath ?? root;
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
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = data.repoPath ? (resolveRepoCwd(root, data.repoPath) ?? root) : root;
		await gitService.stageAll(cwd);
		return { ok: true };
	})

	.http('git:unstage', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const repo = await findRepoForFile(root, data.filePath);
		const cwd = repo?.repoPath ?? root;
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
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = data.repoPath ? (resolveRepoCwd(root, data.repoPath) ?? root) : root;
		await gitService.unstageAll(cwd);
		return { ok: true };
	})

	.http('git:discard', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const repo = await findRepoForFile(root, data.filePath);
		const cwd = repo?.repoPath ?? root;
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
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = data.repoPath ? (resolveRepoCwd(root, data.repoPath) ?? root) : root;
		await gitService.discardAll(cwd);
		return { ok: true };
	});
