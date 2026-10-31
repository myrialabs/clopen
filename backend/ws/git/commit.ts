/**
 * Git Commit Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { identityEnvFor, identityEnvForRemote } from './identity-context';
import { gitRepoContext, withRepoLock } from './repo-context';

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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		const hash = await withRepoLock(ctx, { category: 'commit', label: 'Commit' }, () =>
			gitService.commit(ctx.cwd, data.message, identityEnvFor(data.projectId))
		);
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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		const hash = await withRepoLock(ctx, { category: 'commit', label: 'Amend' }, () =>
			gitService.amendCommit(ctx.cwd, data.message, identityEnvFor(data.projectId))
		);
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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		await withRepoLock(ctx, { category: 'more', label: 'Undo commit' }, () =>
			gitService.undoLastCommit(ctx.cwd, data.mode)
		);
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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'more', label: 'Revert' }, () =>
			gitService.revertCommit(ctx.cwd, data.ref, identityEnvFor(data.projectId))
		);
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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'more', label: 'Cherry-pick' }, () =>
			gitService.cherryPick(ctx.cwd, data.hashes, identityEnvFor(data.projectId))
		);
	})

	.http('git:clean', {
		data: t.Object({
			projectId: t.String(),
			/** Also delete ignored files (`-x`) — node_modules, build output, .env. */
			includeIgnored: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		const message = await withRepoLock(ctx, { category: 'more', label: 'Clean' }, () =>
			gitService.cleanUntracked(ctx.cwd, data.includeIgnored)
		);
		return { message };
	})

	.http('git:gc', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		const message = await withRepoLock(ctx, { category: 'more', label: 'Optimize repository' }, () =>
			gitService.optimize(ctx.cwd)
		);
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
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return await withRepoLock(ctx, { category: 'more', label: `npm version ${data.bump}` }, () =>
			gitService.npmVersion(ctx.cwd, data.bump, identityEnvFor(data.projectId))
		);
	})

	// Dry run of `git:clean`, so the confirmation can name what will be deleted.
	.http('git:clean-preview', {
		data: t.Object({
			projectId: t.String(),
			includeIgnored: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ paths: t.Array(t.String()) })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		return { paths: await gitService.cleanPreview(ctx.cwd, data.includeIgnored) };
	})

	.http('git:submodule-update', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId, data.repoPath);
		const message = await withRepoLock(ctx, { category: 'more', label: 'Update submodules' }, async () =>
			gitService.updateSubmodules(ctx.cwd, await identityEnvForRemote(data.projectId, ctx.cwd))
		);
		return { message };
	});
