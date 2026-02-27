/**
 * Git Branch Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../lib/git/git-service';
import { projectQueries } from '../../lib/database/queries/project-queries';

const BranchSchema = t.Object({
	name: t.String(),
	isCurrent: t.Boolean(),
	isRemote: t.Boolean(),
	upstream: t.Optional(t.String()),
	ahead: t.Number(),
	behind: t.Number(),
	lastCommit: t.Optional(t.String())
});

export const branchHandler = createRouter()
	.http('git:branches', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			current: t.String(),
			local: t.Array(BranchSchema),
			remote: t.Array(BranchSchema),
			ahead: t.Number(),
			behind: t.Number()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.getBranches(project.path);
	})

	.http('git:create-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String({ minLength: 1 }),
			startPoint: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.createBranch(project.path, data.name, data.startPoint);
		return { ok: true };
	})

	.http('git:switch-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.switchBranch(project.path, data.name);
		return { ok: true };
	})

	.http('git:delete-branch', {
		data: t.Object({
			projectId: t.String(),
			name: t.String(),
			force: t.Optional(t.Boolean())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.deleteBranch(project.path, data.name, data.force);
		return { ok: true };
	})

	.http('git:rename-branch', {
		data: t.Object({
			projectId: t.String(),
			oldName: t.String(),
			newName: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		await gitService.renameBranch(project.path, data.oldName, data.newName);
		return { ok: true };
	})

	.http('git:merge-branch', {
		data: t.Object({
			projectId: t.String(),
			branchName: t.String()
		}),
		response: t.Object({
			success: t.Boolean(),
			message: t.String()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');
		return await gitService.mergeBranch(project.path, data.branchName);
	});
