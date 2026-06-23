/**
 * Git Log Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectAccess } from '../access';
import { debug } from '$shared/utils/logger';

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

export const logHandler = createRouter()
	.http('git:log', {
		data: t.Object({
			projectId: t.String(),
			limit: t.Optional(t.Number()),
			skip: t.Optional(t.Number()),
			branch: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
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
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.getLog(
			cwd,
			data.limit ?? 50,
			data.skip ?? 0,
			data.branch
		);
	});
