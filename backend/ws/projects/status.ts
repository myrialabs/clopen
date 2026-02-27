/**
 * Projects Status & Presence
 *
 * Real-time presence tracking:
 * - projects:get-status  (HTTP) - Get project status
 * - projects:join        (Event) - User joins a project
 * - projects:leave       (Event) - User leaves a project
 * - projects:presence-updated (Broadcast) - Full presence state
 *
 * Single broadcast event: `projects:presence-updated` contains full state.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { getProjectStatusData, updateUserPresence } from '../../lib/project/status-manager';
import { streamManager } from '../../lib/chat/stream-manager';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

/**
 * Broadcast full presence state of all projects to all connected clients
 */
export async function broadcastPresence() {
	const statuses = await getProjectStatusData();
	ws.emit.global('projects:presence-updated', {
		type: 'presence-updated',
		timestamp: Date.now(),
		data: statuses
	});
}

export const statusHandler = createRouter()
	// Get project status (HTTP)
	.http('projects:get-status', {
		data: t.Object({}),
		response: t.Any()
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);
		return await getProjectStatusData(projectId);
	})

	// User joins a project
	.on('projects:join', {
		data: t.Object({
			userName: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);

		try {
			// Send initial presence for ALL projects
			const allStatuses = await getProjectStatusData();
			ws.emit.user(userId, 'projects:presence-updated', {
				type: 'presence-updated',
				timestamp: Date.now(),
				data: allStatuses
			});

			if (data.userName) {
				updateUserPresence(projectId, userId, data.userName, 'join');

				try {
					streamManager.cleanupProjectStreams(projectId);
				} catch (cleanupError) {
					debug.error('project', 'Error cleaning up project streams:', cleanupError);
				}

				// Auto-cleanup on connection close (tab close, network drop)
				ws.addCleanup(conn, () => {
					updateUserPresence(projectId, userId, '', 'leave');
					debug.log('project', `Auto-cleaned presence for ${userId} from project ${projectId}`);
					broadcastPresence().catch(() => {});
				});

				await broadcastPresence();
			}

			debug.log('project', `User ${userId} joined project ${projectId}`);
		} catch (error) {
			debug.error('project', 'Error joining project:', error);
			ws.emit.user(userId, 'projects:error', {
				error: error instanceof Error ? error.message : 'Failed to join project'
			});
		}
	})

	// User leaves a project
	.on('projects:leave', {
		data: t.Object({
			projectId: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		// Use explicit projectId from client (avoids race condition when switching projects)
		const projectId = data.projectId || ws.getProjectId(conn);
		const userId = ws.getUserId(conn);

		try {
			updateUserPresence(projectId, userId, '', 'leave');
			await broadcastPresence();
			debug.log('project', `User ${userId} left project ${projectId}`);
		} catch (error) {
			debug.error('project', 'Error leaving project:', error);
		}
	})

	// Event declarations
	.emit('projects:presence-updated', t.Object({
		type: t.Literal('presence-updated'),
		timestamp: t.Number(),
		data: t.Any()
	}))

	.emit('projects:error', t.Object({
		error: t.String()
	}));
