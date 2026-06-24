/**
 * Git Conflict Resolution Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findNestedRepoPaths, findRepoForFile } from '../../snapshot/gitignore';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string | null {
	if (!repoPath) return null;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectRoot;
	}
	return resolved;
}

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
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const conflicts = await gitService.getConflictFiles(project.path);

		try {
			const nestedRepoPaths = await findNestedRepoPaths(project.path);
			for (const repoPath of nestedRepoPaths) {
				try {
					const nestedConflicts = await gitService.getConflictFiles(repoPath);
					const prefix = path.relative(project.path, repoPath).replace(/\\/g, '/') + '/';
					for (const conflict of nestedConflicts) {
						conflicts.push({
							...conflict,
							path: prefix + conflict.path
						});
					}
				} catch {
					// Skip nested repos whose conflict status fails
				}
			}
		} catch {
			// Skip finding nested repos if it fails
		}

		return conflicts;
	})

	.http('git:resolve-conflict', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String(),
			resolution: t.Union([t.Literal('ours'), t.Literal('theirs'), t.Literal('custom')]),
			customContent: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const repo = await findRepoForFile(project.path, data.filePath);
		const cwd = repo?.repoPath ?? project.path;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await gitService.resolveConflict(
			cwd,
			filePath,
			data.resolution,
			data.customContent
		);
		return { ok: true };
	})

	.http('git:abort-merge', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath) ?? project.path;
		await gitService.abortMerge(cwd);
		return { ok: true };
	});
