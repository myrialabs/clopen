/**
 * Projects CRUD Operations
 *
 * HTTP endpoints for project management:
 * - List projects in the workspace
 * - Create new project (or re-list an existing one at the same path)
 * - Get project by ID
 * - Update project info
 * - Delete project (remove from the list, or delete it with its chats)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { projectQueries, sessionQueries, snapshotQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { snapshotService } from '../../snapshot/snapshot-service';
import { blobStore } from '../../snapshot/blob-store';
import { streamManager } from '../../chat/stream-manager';
import { cleanupProjectSessions } from '../../terminal/ptykit';
import { broadcastPresence } from '../projects/status';
import { debug } from '$shared/utils/logger';
import { requireProjectAccess } from '../access';
import { runProjectCleanups } from '../../projects/project-cleanup-registry';
import '../../projects/project-cleanup';
import { ensureHomeProject } from '../../projects/home';
import { homeFirst, isHomeProject } from '$shared/utils/home-project';

export const crudHandler = createRouter()
	// List projects in the workspace
	.http('projects:list', {
		data: t.Object({}),
		response: t.Array(t.Any())
	}, async () => {
		await initializeDatabase();
		// Home is always there, listed first — the place a chat with no project
		// selected lives, and where a fresh install lands.
		ensureHomeProject();
		return homeFirst(projectQueries.getListed());
	})

	// Create new project (or re-list an existing project at the same path)
	.http('projects:create', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data }) => {
		await initializeDatabase();
		const { name, path } = data;

		// Check if project with this path already exists. If so, put it back in
		// the list and return the existing record. This covers re-adding a
		// project that was previously removed (mode='remove'), which preserves
		// the project row for session restoration.
		const existing = projectQueries.getByPath(path);
		// Home is already listed, as Home; a second entry for its folder would
		// be the same workspace twice.
		if (existing && isHomeProject(existing)) throw new Error('That folder is the Home workspace and cannot be added as a project');
		if (existing) {
			projectQueries.list(existing.id);
			return existing;
		}

		const now = new Date().toISOString();
		const project = projectQueries.create({
			name,
			path,
			created_at: now,
			last_opened_at: now
		});

		projectQueries.list(project.id);

		return project;
	})

	// Get project by ID
	.http('projects:get', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data }) => {
		requireProjectAccess(data.id);

		// Update last_opened_at when getting project
		projectQueries.updateLastOpened(data.id);
		const updatedProject = projectQueries.getById(data.id);

		return updatedProject;
	})

	// Delete project (remove from list or full delete with sessions)
	.http('projects:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			mode: t.Optional(t.Union([t.Literal('remove'), t.Literal('full')]))
		}),
		response: t.Object({
			id: t.String(),
			deleted: t.Boolean()
		})
	}, async ({ data }) => {
		const target = requireProjectAccess(data.id);
		if (isHomeProject(target)) throw new Error('Home cannot be removed');

		const mode = data.mode ?? 'remove';

		// Clean up terminal (PTY) sessions for this project
		const cleanedStreams = cleanupProjectSessions(data.id);
		debug.log('project', `Cleaned up ${cleanedStreams} terminal sessions for project ${data.id}`);

		if (mode === 'full') {
			// Full delete: remove sessions with blob cleanup, then the project itself
			const sessions = sessionQueries.getByProjectId(data.id);

			if (sessions.length > 0) {
				// Cancel active chat streams
				await Promise.all(
					sessions.map(s => streamManager.cleanupSessionStreams(s.id).catch((err) => {
						debug.warn('project', `Stream cleanup error for session ${s.id} during project delete:`, err);
					}))
				);

				// Collect blob hashes before deleting
				const baselineHashes = new Set<string>();
				for (const s of sessions) {
					for (const h of snapshotService.getSessionBaselineHashes(s.id)) {
						baselineHashes.add(h);
					}
				}
				const allSnapshots = snapshotQueries.getAllByProjectId(data.id);
				const deltaHashes = snapshotQueries.collectBlobHashes(allSnapshots);

				// Clear in-memory baselines
				for (const s of sessions) {
					snapshotService.clearSessionBaseline(s.id);
				}

				// Delete all sessions and related DB data
				const deletedIds = sessionQueries.deleteAllByProjectId(data.id);

				// GC orphaned blobs
				const allBlobsOnDisk = await blobStore.scanAllBlobHashes();
				const stillReferencedByDB = snapshotQueries.getAllReferencedBlobHashes();
				const stillReferencedByMemory = snapshotService.getAllBaselineHashes();
				const blobsToDelete = [...allBlobsOnDisk].filter(
					h => !stillReferencedByDB.has(h) && !stillReferencedByMemory.has(h)
				);
				if (blobsToDelete.length > 0) {
					const deleted = await blobStore.deleteBlobs(blobsToDelete);
					debug.log('project', `Cleaned up ${deleted}/${blobsToDelete.length} orphaned blobs`);
				}

				// Broadcast session deletions
				for (const sessionId of deletedIds) {
					ws.emit.project(data.id, 'sessions:session-deleted', { sessionId, projectId: data.id });
				}
			}
		}

		// In full mode, delete the project record.
		// In remove mode, keep the project record so sessions can be restored.
		if (mode === 'full') {
			await runProjectCleanups(data.id);
			projectQueries.deleteProject(data.id);
		} else {
			projectQueries.unlist(data.id);
		}

		broadcastPresence().catch((err) => {
			debug.warn('project', 'Presence broadcast error after project delete:', err);
		});

		return {
			id: data.id,
			deleted: true
		};
	});
