/**
 * Git Staging Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findRepoForFile } from '../../git/nested-repos';
import { requireProjectWorkspace } from '../access';
import { gitRepoContext, withRepoLock } from './repo-context';

// Index writes queue behind each other rather than refusing: three files staged
// in quick succession are three requests the user meant.
const STAGE = { category: 'staging', label: 'Staging', queue: true } as const;
const UNSTAGE = { category: 'staging', label: 'Unstaging', queue: true } as const;
const DISCARD = { category: 'staging', label: 'Discarding changes', queue: true } as const;

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
		const ctx = gitRepoContext(conn, data.projectId, undefined, repo?.repoPath ?? root);
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await withRepoLock(ctx, STAGE, () => gitService.stageFile(ctx.cwd, filePath));
		return { ok: true };
	})

	.http('git:stage-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, STAGE, () => gitService.stageAll(ctx.cwd));
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
		const ctx = gitRepoContext(conn, data.projectId, undefined, repo?.repoPath ?? root);
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await withRepoLock(ctx, UNSTAGE, () => gitService.unstageFile(ctx.cwd, filePath));
		return { ok: true };
	})

	.http('git:unstage-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, UNSTAGE, () => gitService.unstageAll(ctx.cwd));
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
		const ctx = gitRepoContext(conn, data.projectId, undefined, repo?.repoPath ?? root);
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await withRepoLock(ctx, DISCARD, () => gitService.discardFile(ctx.cwd, filePath));
		return { ok: true };
	})

	.http('git:discard-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, DISCARD, () => gitService.discardAll(ctx.cwd));
		return { ok: true };
	});
