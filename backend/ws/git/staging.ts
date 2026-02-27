/**
 * Git Staging Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

export const stagingHandler = createRouter()
	.http('git:stage', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.stageFile(project.path, data.filePath);
		return { ok: true };
	})

	.http('git:stage-all', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.stageAll(project.path);
		return { ok: true };
	})

	.http('git:unstage', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.unstageFile(project.path, data.filePath);
		return { ok: true };
	})

	.http('git:unstage-all', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.unstageAll(project.path);
		return { ok: true };
	})

	.http('git:discard', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.discardFile(project.path, data.filePath);
		return { ok: true };
	})

	.http('git:discard-all', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.discardAll(project.path);
		return { ok: true };
	});
