/**
 * Git Status Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findNestedRepoPaths } from '../../git/nested-repos';
import { requireProjectWorkspace } from '../access';
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
		const { root } = requireProjectWorkspace(conn, data.projectId);

		const isRepo = await gitService.isRepo(root);
		if (!isRepo) {
			return {
				isRepo: false,
				staged: [],
				unstaged: [],
				untracked: [],
				conflicted: []
			};
		}

		// Fetch outer status and nested repo list in parallel — the walk does
		// not depend on the status result, and on Windows the walk (readdir +
		// check-ignore spawns) is the dominant cost. Sharing the walk via the
		// findNestedRepoPaths cache + inflight dedup also keeps concurrent
		// callers (status + branches triggered together) from walking twice.
		const [status, nestedRepoPaths] = await Promise.all([
			gitService.getStatus(root),
			// Discovery failing must not cost the user the outer repo's status.
			findNestedRepoPaths(root).catch(() => [] as string[])
		]);

		if (nestedRepoPaths.length > 0) {
			const nestedPrefixes = nestedRepoPaths.map(
				(repoPath) => pathRelative(root, repoPath).replace(/\\/g, '/') + '/'
			);

			// Drop outer-repo entries that fall under a nested repo's prefix.
			// When the outer repo already tracked files inside what later became
			// a nested repo (or reports the nested dir itself as a single
			// untracked entry), it surfaces those paths too — colliding with the
			// nested aggregation below and producing duplicate file entries. The
			// nested repo is the source of truth for its own contents, so the
			// outer view of them is dropped.
			if (nestedPrefixes.length > 0) {
				const underNested = (f: { path: string }) =>
					nestedPrefixes.some((p) => f.path === p || f.path.startsWith(p));
				status.staged = status.staged.filter((f) => !underNested(f));
				status.unstaged = status.unstaged.filter((f) => !underNested(f));
				status.untracked = status.untracked.filter((f) => !underNested(f));
				status.conflicted = status.conflicted.filter((f) => !underNested(f));
			}

			// Fetch all nested statuses in parallel instead of sequentially.
			// Each `git status` is a separate spawn; on Windows Defender scans
			// .git/index per call, so sequential loops multiplied the wait.
			const nestedStatuses = await Promise.all(
				nestedRepoPaths.map(async (repoPath) => {
					try {
						const nestedStatus = await gitService.getStatus(repoPath);
						return { repoPath, nestedStatus };
					} catch {
						return null;
					}
				})
			);

			for (const entry of nestedStatuses) {
				if (!entry) continue;
				const prefix = pathRelative(root, entry.repoPath).replace(/\\/g, '/') + '/';
				const withPrefix = (f: typeof entry.nestedStatus.staged[number]) => ({
					...f,
					path: prefix + f.path,
					oldPath: f.oldPath ? prefix + f.oldPath : undefined
				});
				status.staged.push(...entry.nestedStatus.staged.map(withPrefix));
				status.unstaged.push(...entry.nestedStatus.unstaged.map(withPrefix));
				status.untracked.push(...entry.nestedStatus.untracked.map(withPrefix));
				status.conflicted.push(...entry.nestedStatus.conflicted.map(withPrefix));
			}
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
		const { root } = requireProjectWorkspace(conn, data.projectId);
		await gitService.init(root, data.defaultBranch);
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
		const { root } = requireProjectWorkspace(conn, data.projectId);

		const isRepo = await gitService.isRepo(root);
		const repoRoot = isRepo ? await gitService.getRoot(root) : undefined;
		return { isRepo, root: repoRoot ?? undefined };
	});
