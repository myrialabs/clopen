/**
 * Git Commit Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

export const commitHandler = createRouter()
	.http('git:commit', {
		data: t.Object({
			projectId: t.String(),
			message: t.String({ minLength: 1 })
		}),
		response: t.Object({
			hash: t.String()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		const hash = await gitService.amendCommit(project.path, data.message);
		return { hash };
	});
