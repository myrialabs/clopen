/**
 * Git Diff Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findRepoForFile } from '../../snapshot/gitignore';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

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

/**
 * Resolve the working directory for a git operation. Defaults to the project
 * root; when `repoPath` is provided it must already be inside the project.
 */
function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string {
	if (!repoPath) return projectPath;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectPath;
	}
	return resolved;
}

export const diffHandler = createRouter()
	.http('git:diff-unstaged', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.Optional(t.String())
		}),
		response: t.Array(FileDiffSchema)
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		// Route the diff to the nested repo that owns the file (if any) —
		// the outer repo's `git diff` returns nothing for files that are
		// tracked inside a nested repo and gitignored by the parent.
		const repo = data.filePath
			? await findRepoForFile(project.path, data.filePath)
			: null;
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		return await gitService.getDiffUnstaged(cwd, filePath);
	})

	.http('git:diff-staged', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.Optional(t.String())
		}),
		response: t.Array(FileDiffSchema)
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const repo = data.filePath
			? await findRepoForFile(project.path, data.filePath)
			: null;
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		return await gitService.getDiffStaged(cwd, filePath);
	})

	.http('git:diff-commit', {
		data: t.Object({
			projectId: t.String(),
			commitHash: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			files: t.Array(FileDiffSchema),
			subject: t.String(),
			body: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.getDiffCommit(cwd, data.commitHash);
	});
