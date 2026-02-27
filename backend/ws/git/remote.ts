/**
 * Git Remote Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		const message = await gitService.fetch(project.path, data.remote);
		return { message };
	})

	.http('git:pull', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			branch: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.pull(project.path, data.remote, data.branch);
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.push(project.path, data.remote, data.branch, data.force);
	})

	.http('git:add-remote', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			url: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.addRemote(project.path, data.name, data.url);
		return { ok: true };
	})

	.http('git:remove-remote', {
		data: t.Object({
			projectId: t.String(),
			name: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.removeRemote(project.path, data.name);
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.stashList(project.path);
	})

	.http('git:stash-save', {
		data: t.Object({
			projectId: t.String(),
			message: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.stashSave(project.path, data.message);
		return { ok: true };
	})

	.http('git:stash-pop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.stashPop(project.path, data.index);
		return { ok: true };
	})

	.http('git:stash-drop', {
		data: t.Object({
			projectId: t.String(),
			index: t.Optional(t.Number())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.stashDrop(project.path, data.index);
		return { ok: true };
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.createTag(project.path, data.name, data.message, data.commitHash);
		return { ok: true };
	})

	.http('git:delete-tag', {
		data: t.Object({
			projectId: t.String(),
			name: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.pushTag(project.path, data.name, data.remote);
	});
