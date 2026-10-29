/**
 * Projects Status
 *
 * Live chat-stream status of every project, mirrored on every device so busy
 * and waiting-for-input indicators stay in sync:
 * - projects:get-status  (HTTP) - Status of the current project
 * - projects:join        (Event) - A device opened a project; replies with every project's status
 * - projects:presence-updated (Broadcast) - Full status of all projects
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { getProjectStatusData } from '../../project/status-manager';
import { streamManager } from '../../chat/stream-manager';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

/**
 * Broadcast the full status of all projects to all connected clients
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

	// A device opened a project
	.on('projects:join', {
		data: t.Object({})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);

		try {
			// Send initial status for ALL projects
			const allStatuses = await getProjectStatusData();
			ws.emit.user(userId, 'projects:presence-updated', {
				type: 'presence-updated',
				timestamp: Date.now(),
				data: allStatuses
			});

			try {
				streamManager.cleanupProjectStreams(projectId);
			} catch (cleanupError) {
				debug.error('project', 'Error cleaning up project streams:', cleanupError);
			}

			debug.log('project', `Device joined project ${projectId}`);
		} catch (error) {
			debug.error('project', 'Error joining project:', error);
			ws.emit.user(userId, 'projects:error', {
				error: error instanceof Error ? error.message : 'Failed to join project'
			});
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
