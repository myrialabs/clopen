/**
 * Git Status Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findNestedRepoPaths } from '../../snapshot/gitignore';
import { requireProjectAccess } from '../access';
import { relative as pathRelative } from 'path';

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
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);

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

		// Also aggregate status from nested git repos living inside the
		// project (e.g. a theme extracted into its own repo, listed in the
		// parent's .gitignore). The outer repo's `git status` skips them
		// entirely, so without this aggregation the Changes tab would not
		// show edits the AI made inside the nested repo.
		try {
			const nestedRepoPaths = await findNestedRepoPaths(project.path);
			for (const repoPath of nestedRepoPaths) {
				try {
					const nestedStatus = await gitService.getStatus(repoPath);
					const prefix = pathRelative(project.path, repoPath).replace(/\\/g, '/') + '/';
					const withPrefix = (f: typeof nestedStatus.staged[number]) => ({
						...f,
						path: prefix + f.path,
						oldPath: f.oldPath ? prefix + f.oldPath : undefined
					});
					status.staged.push(...nestedStatus.staged.map(withPrefix));
					status.unstaged.push(...nestedStatus.unstaged.map(withPrefix));
					status.untracked.push(...nestedStatus.untracked.map(withPrefix));
					status.conflicted.push(...nestedStatus.conflicted.map(withPrefix));
				} catch {
					// Skip repos whose git status fails — don't break the
					// whole response because one nested repo is broken.
				}
			}
		} catch {
			// If findNestedRepoPaths itself fails, just return outer status
		}

		return { isRepo: true, ...status };
	})

	.http('git:init', {
		data: t.Object({
			projectId: t.String(),
			defaultBranch: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
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
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);

		const isRepo = await gitService.isRepo(project.path);
		const root = isRepo ? await gitService.getRoot(project.path) : undefined;
		return { isRepo, root: root ?? undefined };
	});
