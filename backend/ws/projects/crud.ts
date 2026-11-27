/**
 * Projects CRUD Operations
 *
 * HTTP endpoints for project management:
 * - List projects in the workspace
 * - Create new project (or re-list an existing one at the same path)
 * - Get project by ID
 * - Rename a project's folder, or point it at a folder moved elsewhere
 * - Delete project (remove from the list, or delete it with its chats)
 */

import { t } from 'elysia';
import { basename } from 'path';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { projectQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { cleanupProjectSessions } from '../../terminal/ptykit';
import { broadcastPresence } from '../projects/status';
import { debug } from '$shared/utils/logger';
import { requireProjectAccess } from '../access';
import { runProjectCleanups } from '../../projects/project-cleanup-registry';
import { purgeSessions } from '../../storage/purge';
import '../../projects/project-cleanup';
import { ensureHomeProject } from '../../projects/home';
import { homeFirst, isHomeProject } from '$shared/utils/home-project';
import { getProjectUsage, moveProject, withFolderState } from '../../projects/move';

const usageSchema = t.Object({ chats: t.Number(), terminals: t.Number() });

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
		return homeFirst(projectQueries.getListed()).map(withFolderState);
	})

	// Create new project (or re-list an existing project at the same path).
	// The name is always the folder's: renaming a project renames its folder.
	.http('projects:create', {
		data: t.Object({
			path: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data }) => {
		await initializeDatabase();
		const { path } = data;
		const name = basename(path) || path;

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
			return withFolderState(existing);
		}

		const now = new Date().toISOString();
		const project = projectQueries.create({
			name,
			path,
			created_at: now,
			last_opened_at: now
		});

		projectQueries.list(project.id);

		return withFolderState(project);
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

		return updatedProject ? withFolderState(updatedProject) : updatedProject;
	})

	// What would stop a project from being moved right now: chats generating
	// and shells running in its main tree.
	.http('projects:usage', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: usageSchema
	}, async ({ data }) => {
		requireProjectAccess(data.id);
		return getProjectUsage(data.id);
	})

	// Rename a project's folder on disk; the project's name follows it. Answers
	// `busy` while work runs there, unless `force` stops that work first.
	.http('projects:rename', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			force: t.Optional(t.Boolean())
		}),
		response: t.Any()
	}, async ({ data }) => {
		requireProjectAccess(data.id);
		return await moveProject(data.id, { kind: 'rename', name: data.name }, data.force);
	})

	// Point a project at the folder it now lives in, after it was moved or
	// renamed outside Clopen. Same carrying-along as a rename, minus the rename.
	.http('projects:relocate', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 }),
			force: t.Optional(t.Boolean())
		}),
		response: t.Any()
	}, async ({ data }) => {
		requireProjectAccess(data.id);
		return await moveProject(data.id, { kind: 'relocate', path: data.path }, data.force);
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
			// Full delete: every chat goes through the shared purge (streams,
			// snapshot blobs, memory bookkeeping, engine transcripts).
			const { deletedIds } = await purgeSessions([], { wholeProject: data.id });
			for (const sessionId of deletedIds) {
				ws.emit.project(data.id, 'sessions:session-deleted', { sessionId, projectId: data.id });
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
	})

	.emit('projects:updated', t.Object({
		project: t.Any(),
		previousPath: t.String()
	}));
