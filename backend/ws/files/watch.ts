/**
 * File Watch Handlers
 *
 * Real-time file system watching:
 * - Watch project directory for changes
 * - Unwatch project directory
 * - File change events
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { fileWatcher } from '$backend/lib/files/file-watcher';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/lib/utils/ws';

export const watchHandler = createRouter()
	// Start watching a project directory
	.on('files:watch', {
		data: t.Object({
			projectPath: t.String({ minLength: 1 })
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const { projectPath } = data;

		try {
			// Check if already watching
			if (fileWatcher.isWatching(projectId)) {
				// Already watching, broadcast confirmation (frontend filters by projectId)
				ws.emit.project(projectId, 'files:watching', {
					projectId,
					watching: true,
					timestamp: Date.now()
				});
				return;
			}

			// Start watching
			const success = await fileWatcher.startWatching(projectId, projectPath);

			if (success) {
				// Broadcast confirmation (frontend filters by projectId)
				ws.emit.project(projectId, 'files:watching', {
					projectId,
					watching: true,
					timestamp: Date.now()
				});

				debug.log('file', `Started watching project ${projectId}`);
			} else {
				// Broadcast error (frontend filters by projectId)
				ws.emit.project(projectId, 'files:watch-error', {
					projectId,
					error: 'Failed to start file watcher'
				});
			}
		} catch (error) {
			debug.error('file', 'Error starting file watch:', error);
			ws.emit.project(projectId, 'files:watch-error', {
				projectId,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	})

	// Stop watching a project directory
	.on('files:unwatch', {
		data: t.Object({})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		try {
			const success = fileWatcher.stopWatching(projectId);

			// Broadcast confirmation (frontend filters by projectId)
			ws.emit.project(projectId, 'files:watching', {
				projectId,
				watching: false,
				timestamp: Date.now()
			});

			if (success) {
				debug.log('file', `Stopped watching project ${projectId}`);
			}
		} catch (error) {
			debug.error('file', 'Error stopping file watch:', error);
		}
	})

	// Event declarations for type safety

	// Emitted when file watcher status changes
	.emit('files:watching', t.Object({
		projectId: t.String(),
		watching: t.Boolean(),
		timestamp: t.Number()
	}))

	// Emitted when files change
	.emit('files:changed', t.Object({
		projectId: t.String(),
		changes: t.Array(t.Object({
			path: t.String(),
			type: t.Union([
				t.Literal('created'),
				t.Literal('modified'),
				t.Literal('deleted')
			]),
			timestamp: t.String()
		})),
		timestamp: t.Number()
	}))

	// Emitted on watcher errors
	.emit('files:watch-error', t.Object({
		projectId: t.String(),
		error: t.String()
	}))

	// Emitted when git state changes (external git operations)
	.emit('git:changed', t.Object({
		projectId: t.String(),
		timestamp: t.Number()
	}));
