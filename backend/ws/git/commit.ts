/**
 * Git Commit Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectAccess } from '../access';

export const commitHandler = createRouter()
	.http('git:commit', {
		data: t.Object({
			projectId: t.String(),
			message: t.String({ minLength: 1 })
		}),
		response: t.Object({
			hash: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const hash = await gitService.commit(project.path, data.message);
		return { hash };
	})

	.http('git:amend', {
		data: t.Object({
			projectId: t.String(),
			message: t.Optional(t.String())
		}),
		response: t.Object({
			hash: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const hash = await gitService.amendCommit(project.path, data.message);
		return { hash };
	})

	.http('git:undo-commit', {
		data: t.Object({
			projectId: t.String(),
			mode: t.Union([t.Literal('soft'), t.Literal('mixed'), t.Literal('hard')])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.undoLastCommit(project.path, data.mode);
		return { ok: true };
	})

	.http('git:revert', {
		data: t.Object({
			projectId: t.String(),
			ref: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.revertCommit(project.path, data.ref);
	})

	.http('git:cherry-pick', {
		data: t.Object({
			projectId: t.String(),
			hashes: t.Array(t.String(), { minItems: 1 })
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.cherryPick(project.path, data.hashes);
	})

	.http('git:clean', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const message = await gitService.cleanUntracked(project.path);
		return { message };
	})

	.http('git:gc', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ message: t.String() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const message = await gitService.optimize(project.path);
		return { message };
	})

	.http('git:npm-version', {
		data: t.Object({
			projectId: t.String(),
			bump: t.Union([t.Literal('patch'), t.Literal('minor'), t.Literal('major')])
		}),
		response: t.Object({
			success: t.Boolean(),
			version: t.String(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.npmVersion(project.path, data.bump);
	});
