/**
 * Git Status Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';
import { ws as wsServer } from '../../lib/utils/ws';

export const statusHandler = createRouter()
	.http('git:status', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			isRepo: t.Boolean(),
			staged: t.Array(t.Object({
				path: t.String(),
				indexStatus: t.String(),
				workingStatus: t.String(),
				oldPath: t.Optional(t.String())
			})),
			unstaged: t.Array(t.Object({
				path: t.String(),
				indexStatus: t.String(),
				workingStatus: t.String(),
				oldPath: t.Optional(t.String())
			})),
			untracked: t.Array(t.Object({
				path: t.String(),
				indexStatus: t.String(),
				workingStatus: t.String(),
				oldPath: t.Optional(t.String())
			})),
			conflicted: t.Array(t.Object({
				path: t.String(),
				indexStatus: t.String(),
				workingStatus: t.String(),
				oldPath: t.Optional(t.String())
			}))
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');

		const isRepo = await gitService.isRepo(project.path);
		if (!isRepo) {
			return {
				isRepo: false,
				staged: [],
				unstaged: [],
				untracked: [],
				conflicted: []
			};
		}

		const status = await gitService.getStatus(project.path);
		return { isRepo: true, ...status };
	})

	.http('git:init', {
		data: t.Object({
			projectId: t.String(),
			defaultBranch: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.init(project.path, data.defaultBranch);
		return { ok: true };
	})

	.http('git:is-repo', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			isRepo: t.Boolean(),
			root: t.Optional(t.String())
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');

		const isRepo = await gitService.isRepo(project.path);
		const root = isRepo ? await gitService.getRoot(project.path) : undefined;
		return { isRepo, root: root ?? undefined };
	});
