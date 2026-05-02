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
	});
