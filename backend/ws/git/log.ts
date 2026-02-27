/**
 * Git Log Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

export const logHandler = createRouter()
	.http('git:log', {
		data: t.Object({
			projectId: t.String(),
			limit: t.Optional(t.Number()),
			skip: t.Optional(t.Number()),
			branch: t.Optional(t.String())
		}),
		response: t.Object({
			commits: t.Array(t.Object({
				hash: t.String(),
				hashShort: t.String(),
				author: t.String(),
				authorEmail: t.String(),
				date: t.String(),
				message: t.String(),
				parents: t.Array(t.String()),
				refs: t.Optional(t.Array(t.String()))
			})),
			total: t.Number(),
			hasMore: t.Boolean()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getLog(
			project.path,
			data.limit ?? 50,
			data.skip ?? 0,
			data.branch
		);
	});
