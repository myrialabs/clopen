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
import { initializeDatabase } from '../../lib/database';
import { projectQueries } from '../../lib/database/queries';
import { ws } from '$backend/lib/utils/ws';

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
	}, async ({ data }) => {
		const project = projectQueries.getById(data.id);

		if (!project) {
			throw new Error('Project not found');
		}

		// Update last_opened_at when getting project
		projectQueries.updateLastOpened(data.id);
		const updatedProject = projectQueries.getById(data.id);

		return updatedProject;
	})

	// Delete project (remove user association, cleanup if orphaned)
	.http('projects:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			id: t.String(),
			deleted: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const project = projectQueries.getById(data.id);
		if (!project) {
			throw new Error('Project not found');
		}

		// Remove user's association with the project
		projectQueries.removeUserProject(userId, data.id);

		// If no more users are associated, delete the project entirely
		const remainingUsers = projectQueries.getUserCountForProject(data.id);
		if (remainingUsers === 0) {
			projectQueries.delete(data.id);
		}

		return {
			id: data.id,
			deleted: true
		};
	});
