import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	listUsers,
	removeUser,
	listUserProjects,
	assignProjectToUser,
	unassignProjectFromUser
} from '$backend/auth/auth-service';
import { ws } from '$backend/utils/ws';

export const usersHandler = createRouter()
	// List all users (admin only — enforced by auth gate)
	.http('auth:list-users', {
		data: t.Object({}),
		response: t.Array(t.Object({
			id: t.String(),
			name: t.String(),
			role: t.Union([t.Literal('admin'), t.Literal('member')]),
			color: t.String(),
			avatar: t.String(),
			createdAt: t.String()
		}))
	}, async () => {
		return listUsers();
	})

	// Remove user (admin only)
	.http('auth:remove-user', {
		data: t.Object({
			userId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		removeUser(data.userId);
		ws.emit.global('auth:users-changed', { type: 'removed', userId: data.userId });
		return { success: true };
	})

	// List projects assigned to a specific user (admin only)
	.http('auth:list-user-projects', {
		data: t.Object({
			userId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Any())
	}, async ({ data }) => {
		return listUserProjects(data.userId);
	})

	// Assign a project to a user (admin only)
	.http('auth:assign-project', {
		data: t.Object({
			userId: t.String({ minLength: 1 }),
			projectId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			added: t.Boolean()
		})
	}, async ({ data }) => {
		const added = assignProjectToUser(data.userId, data.projectId);
		if (added) {
			ws.emit.global('auth:user-projects-changed', {
				type: 'assigned',
				userId: data.userId,
				projectId: data.projectId
			});
		}
		return { added };
	})

	// Revoke a user's access to a project (admin only)
	.http('auth:unassign-project', {
		data: t.Object({
			userId: t.String({ minLength: 1 }),
			projectId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			removed: t.Boolean()
		})
	}, async ({ data }) => {
		const removed = unassignProjectFromUser(data.userId, data.projectId);
		if (removed) {
			ws.emit.global('auth:user-projects-changed', {
				type: 'unassigned',
				userId: data.userId,
				projectId: data.projectId
			});
		}
		return { removed };
	});
