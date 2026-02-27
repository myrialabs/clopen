/**
 * Git Conflict Resolution Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

const ConflictMarkerSchema = t.Object({
	ourStart: t.Number(),
	ourEnd: t.Number(),
	theirStart: t.Number(),
	theirEnd: t.Number(),
	baseStart: t.Optional(t.Number()),
	baseEnd: t.Optional(t.Number()),
	ourContent: t.String(),
	theirContent: t.String(),
	baseContent: t.Optional(t.String())
});

export const conflictHandler = createRouter()
	.http('git:conflict-files', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Array(t.Object({
			path: t.String(),
			content: t.String(),
			markers: t.Array(ConflictMarkerSchema)
		}))
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getConflictFiles(project.path);
	})

	.http('git:resolve-conflict', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String(),
			resolution: t.Union([t.Literal('ours'), t.Literal('theirs'), t.Literal('custom')]),
			customContent: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.resolveConflict(
			project.path,
			data.filePath,
			data.resolution,
			data.customContent
		);
		return { ok: true };
	})

	.http('git:abort-merge', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.abortMerge(project.path);
		return { ok: true };
	});
