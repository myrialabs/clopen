/**
 * Projects CRUD Operations
 *
 * HTTP endpoints for project management:
 * - List all projects (per-user)
 * - Create new project (or join existing)
 * - Get project by ID
 * - Update project info
 * - Delete project (remove user association, cleanup if orphaned)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { projectQueries, sessionQueries, snapshotQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { snapshotService } from '../../snapshot/snapshot-service';
import { blobStore } from '../../snapshot/blob-store';
import { streamManager } from '../../chat/stream-manager';
import { terminalStreamManager } from '../../terminal/stream-manager';
import { broadcastPresence } from '../projects/status';
import { debug } from '$shared/utils/logger';
import { requireProjectAccess } from '../access';

export const crudHandler = createRouter()
	// List all projects for the current user
	.http('projects:list', {
		data: t.Object({}),
		response: t.Array(t.Any())
	}, async ({ conn }) => {
		await initializeDatabase();
		const userId = ws.getUserId(conn);
		const projects = projectQueries.getAllForUser(userId);
		return projects;
	})

	// Create new project (or join existing by path)
	.http('projects:create', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		await initializeDatabase();
		const userId = ws.getUserId(conn);
		const { name, path } = data;

		// Check if project with this path already exists
		const existing = projectQueries.getByPath(path);
		if (existing) {
			// Project exists - just add user association (join)
			projectQueries.addUserProject(userId, existing.id);
			return existing;
		}

		const now = new Date().toISOString();
		const project = projectQueries.create({
			name,
			path,
			created_at: now,
			last_opened_at: now
		});

		// Associate the project with the creating user
		projectQueries.addUserProject(userId, project.id);

		return project;
	})

	// Get project by ID
	.http('projects:get', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.id);

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
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		requireProjectAccess(conn, data.id);

		const mode = data.mode ?? 'remove';

		// Clean up terminal streams for this project
		const cleanedStreams = terminalStreamManager.cleanupProjectStreams(data.id);
		debug.log('project', `Cleaned up ${cleanedStreams} terminal streams for project ${data.id}`);

		if (mode === 'full') {
			// Full delete: remove sessions with blob cleanup, then the project itself
			const sessions = sessionQueries.getByProjectId(data.id);

			if (sessions.length > 0) {
				// Cancel active chat streams
				await Promise.all(
					sessions.map(s => streamManager.cleanupSessionStreams(s.id).catch(() => {}))
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

		// Remove user's association with the project
		projectQueries.removeUserProject(userId, data.id);

		// In full mode, delete the project record if no users remain
		// In remove mode, keep the project record so sessions can be restored
		if (mode === 'full') {
			const remainingUsers = projectQueries.getUserCountForProject(data.id);
			if (remainingUsers === 0) {
				projectQueries.deleteProject(data.id);
			}
		}

		broadcastPresence().catch(() => {});

		return {
			id: data.id,
			deleted: true
		};
	});
