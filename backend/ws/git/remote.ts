/**
 * Git Remote Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { requireProjectAccess } from '../access';

export const remoteHandler = createRouter()
	.http('git:remotes', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Array(t.Object({
			name: t.String(),
			fetchUrl: t.String(),
			pushUrl: t.String()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.getRemotes(project.path);
	})

	.http('git:fetch', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const message = await gitService.fetch(project.path, data.remote);
		return { message };
	})

	.http('git:pull', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String()),
			rebase: t.Optional(t.Boolean())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.pull(project.path, data.remote, data.branch, data.rebase);
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
			branch: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.pushAdvanced(project.path, data.mode, data.remote, data.branch);
	})

	.http('git:fetch-all', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const message = await gitService.fetchAll(project.path);
		return { message };
	})

	.http('git:push', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String()),
			force: t.Optional(t.Boolean())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.push(project.path, data.remote, data.branch, data.force);
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
			branch: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.deleteRemoteBranch(project.path, data.remote, data.branch);
		return { ok: true };
	})

	.http('git:stash-list', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Array(t.Object({
			index: t.Number(),
			message: t.String(),
			date: t.String()
		}))
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.stashList(project.path);
	})

	.http('git:stash-save', {
		data: t.Object({
			projectId: t.String(),
			message: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.stashSave(project.path, data.message);
		return { ok: true };
	})

	.http('git:stash-pop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number())
		}),
		response: t.Object({
			success: t.Boolean(),
			hasConflicts: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.stashPop(project.path, data.index);
	})

	.http('git:stash-drop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.stashDrop(project.path, data.index);
		return { ok: true };
	})

	.http('git:stash-diff', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number())
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
		return await gitService.stashDiff(project.path, data.index);
	})

	.http('git:tags', {
		data: t.Object({
			projectId: t.String()
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
		return await gitService.getTags(project.path);
	})

	.http('git:create-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String({ minLength: 1 }),
			message: t.Optional(t.String()),
			commitHash: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.createTag(project.path, data.name, data.message, data.commitHash);
		return { ok: true };
	})

	.http('git:delete-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		await gitService.deleteTag(project.path, data.name);
		return { ok: true };
	})

	.http('git:push-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			remote: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		return await gitService.pushTag(project.path, data.name, data.remote);
	});

