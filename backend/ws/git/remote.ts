/**
 * Git Remote Handler
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

export const remoteHandler = createRouter()
	.http('git:remotes', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Array(t.Object({
			name: t.String(),
			fetchUrl: t.String(),
			pushUrl: t.String()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.getRemotes(cwd);
	})

	.http('git:fetch', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const message = await gitService.fetch(cwd, data.remote);
		return { message };
	})

	.http('git:pull', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String()),
			rebase: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.pull(cwd, data.remote, data.branch, data.rebase);
	})

	.http('git:push-advanced', {
		data: t.Object({
			projectId: t.String(),
			mode: t.Union([
				t.Literal('with-tags'),
				t.Literal('all-tags'),
				t.Literal('force-lease'),
				t.Literal('force')
			]),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.pushAdvanced(cwd, data.mode, data.remote, data.branch);
	})

	.http('git:fetch-all', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		const message = await gitService.fetchAll(cwd);
		return { message };
	})

	.http('git:push', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String()),
			force: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.push(cwd, data.remote, data.branch, data.force);
	})

	.http('git:add-remote', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			url: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.addRemote(project.path, data.name, data.url);
		return { ok: true };
	})

	.http('git:set-remote-url', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			url: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.setRemoteUrl(project.path, data.name, data.url);
		return { ok: true };
	})

	.http('git:rename-remote', {
		data: t.Object({
			projectId: t.String(),
			oldName: t.String(),
			newName: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.renameRemote(project.path, data.oldName, data.newName);
		return { ok: true };
	})

	.http('git:edit-remote', {
		data: t.Object({
			projectId: t.String(),
			oldName: t.String(),
			newName: t.String(),
			newUrl: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		if (data.oldName !== data.newName) {
			await gitService.renameRemote(project.path, data.oldName, data.newName);
		}
		await gitService.setRemoteUrl(project.path, data.newName, data.newUrl);
		return { ok: true };
	})

	.http('git:remove-remote', {
		data: t.Object({
			projectId: t.String(),
			name: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.removeRemote(project.path, data.name);
		return { ok: true };
	})

	.http('git:delete-remote-branch', {
		data: t.Object({
			projectId: t.String(),
			remote: t.String(),
			branch: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.deleteRemoteBranch(cwd, data.remote, data.branch);
		return { ok: true };
	})

	.http('git:stash-list', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Array(t.Object({
			index: t.Number(),
			message: t.String(),
			date: t.String()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.stashList(cwd);
	})

	.http('git:stash-save', {
		data: t.Object({
			projectId: t.String(),
			message: t.Optional(t.String()),
			staged: t.Optional(t.Boolean()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.stashSave(cwd, data.message, data.staged);
		return { ok: true };
	})

	.http('git:stash-pop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			hasConflicts: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.stashPop(cwd, data.index);
	})

	.http('git:stash-drop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.stashDrop(cwd, data.index);
		return { ok: true };
	})

	.http('git:stash-diff', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Array(t.Object({
			oldPath: t.String(),
			newPath: t.String(),
			status: t.String(),
			hunks: t.Array(t.Object({
				oldStart: t.Number(),
				oldLines: t.Number(),
				newStart: t.Number(),
				newLines: t.Number(),
				header: t.String(),
				lines: t.Array(t.Object({
					type: t.Union([t.Literal('add'), t.Literal('delete'), t.Literal('context'), t.Literal('header')]),
					content: t.String(),
					oldLineNumber: t.Optional(t.Number()),
					newLineNumber: t.Optional(t.Number())
				}))
			})),
			isBinary: t.Boolean()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.stashDiff(cwd, data.index);
	})

	.http('git:tags', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Array(t.Object({
			name: t.String(),
			hash: t.String(),
			message: t.String(),
			date: t.String(),
			isAnnotated: t.Boolean()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.getTags(cwd);
	})

	.http('git:create-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String({ minLength: 1 }),
			message: t.Optional(t.String()),
			commitHash: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.createTag(cwd, data.name, data.message, data.commitHash);
		return { ok: true };
	})

	.http('git:delete-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		await gitService.deleteTag(cwd, data.name);
		return { ok: true };
	})

	.http('git:push-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			remote: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);
		return await gitService.pushTag(cwd, data.name, data.remote);
	});
