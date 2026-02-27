/**
 * Git Diff Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

const DiffHunkLineSchema = t.Object({
	type: t.Union([t.Literal('add'), t.Literal('delete'), t.Literal('context'), t.Literal('header')]),
	content: t.String(),
	oldLineNumber: t.Optional(t.Number()),
	newLineNumber: t.Optional(t.Number())
});

const DiffHunkSchema = t.Object({
	oldStart: t.Number(),
	oldLines: t.Number(),
	newStart: t.Number(),
	newLines: t.Number(),
	header: t.String(),
	lines: t.Array(DiffHunkLineSchema)
});

const FileDiffSchema = t.Object({
	oldPath: t.String(),
	newPath: t.String(),
	status: t.String(),
	hunks: t.Array(DiffHunkSchema),
	isBinary: t.Boolean()
});

export const diffHandler = createRouter()
	.http('git:diff-unstaged', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.Optional(t.String())
		}),
		response: t.Array(FileDiffSchema)
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getDiffUnstaged(project.path, data.filePath);
	})

	.http('git:diff-staged', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.Optional(t.String())
		}),
		response: t.Array(FileDiffSchema)
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getDiffStaged(project.path, data.filePath);
	})

	.http('git:diff-commit', {
		data: t.Object({
			projectId: t.String(),
			commitHash: t.String()
		}),
		response: t.Array(FileDiffSchema)
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getDiffCommit(project.path, data.commitHash);
	});
