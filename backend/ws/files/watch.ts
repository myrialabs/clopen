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
import { fileWatcher } from '$backend/files/file-watcher';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { projectQueries } from '../../database/queries/project-queries';
import { requireProjectAccess } from '../access';

// Connection ids that already have a disconnect cleanup registered, so we
// don't stack duplicate cleanups when a connection re-watches across switches.
const cleanupRegistered = new Set<string>();

export const watchHandler = createRouter()
	// Start watching a project directory
	.on('files:watch', {
		data: t.Object({
			projectPath: t.String({ minLength: 1 })
		})
	}, async ({ data, conn }) => {
		const { projectPath } = data;

		const project = projectQueries.getByPath(projectPath);
		if (!project) throw new Error('Access denied');
		requireProjectAccess(conn, project.id);
		const projectId = project.id;

		try {
			const connId = ws.getConnectionId(conn);

			// Tear down the watcher automatically if the connection drops without
			// sending an explicit unwatch (tab close, network loss).
			if (connId && !cleanupRegistered.has(connId)) {
				cleanupRegistered.add(connId);
				ws.addCleanup(conn, () => {
					cleanupRegistered.delete(connId);
					fileWatcher.removeViewerFromAll(connId);
				});
			}

			// Register this connection as a viewer; starts the watcher if it is
			// the first viewer, otherwise reuses the existing one.
			const success = connId
				? await fileWatcher.addViewer(connId, projectId, projectPath)
				: await fileWatcher.startWatching(projectId, projectPath);

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

	// Stop watching a project directory.
	// Resolves the target project from the explicit `projectPath` (the project
	// being left) rather than the connection's current project context — by the
	// time this fires the context has usually already advanced to the new
	// project, so relying on it would unwatch the wrong one.
	.on('files:unwatch', {
		data: t.Object({
			projectPath: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		let projectId: string;
		if (data.projectPath) {
			const project = projectQueries.getByPath(data.projectPath);
			if (!project) return; // unknown path — nothing to unwatch
			requireProjectAccess(conn, project.id);
			projectId = project.id;
		} else {
			// Backwards-compatible fallback for callers that don't send a path.
			projectId = ws.getProjectId(conn);
		}

		try {
			const connId = ws.getConnectionId(conn);
			if (connId) {
				// Drops this viewer; watcher is stopped only when none remain.
				fileWatcher.removeViewer(connId, projectId);
			} else {
				fileWatcher.stopWatching(projectId);
			}

			// Broadcast the ACTUAL resulting state — other devices may still be
			// viewing this project, in which case the watcher is still alive and
			// they must not be told it stopped.
			ws.emit.project(projectId, 'files:watching', {
				projectId,
				watching: fileWatcher.isWatching(projectId),
				timestamp: Date.now()
			});

			debug.log('file', `Viewer left project ${projectId}`);
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
