/**
 * Sessions CRUD Operations
 *
 * HTTP endpoints for session management:
 * - List sessions (all or by project)
 * - Create new session
 * - Get session by ID (with messages)
 * - Get or create shared session
 * - Update session (title, reactivate, end)
 * - Delete session
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { EngineType } from '$shared/types/engine';
import { sessionQueries, messageQueries, projectQueries } from '../../lib/database/queries';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export const crudHandler = createRouter()
	// List sessions (includes server-saved current session ID for refresh restore)
	.http('sessions:list', {
		data: t.Object({}),
		response: t.Object({
			sessions: t.Array(t.Object({
				id: t.String(),
				project_id: t.String(),
				title: t.Optional(t.String()),
				engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
				model: t.Optional(t.String()),
				latest_sdk_session_id: t.Optional(t.String()),
				current_head_message_id: t.Optional(t.String()),
				started_at: t.String(),
				ended_at: t.Optional(t.String())
			})),
			currentSessionId: t.Optional(t.String())
		})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);
		const sessions = sessionQueries.getByProjectId(projectId);

		// Get the user's saved current session for this project
		const currentSessionId = projectQueries.getCurrentSessionId(userId, projectId);

		// Convert null to undefined for TypeScript optional fields
		return {
			sessions: sessions.map(session => ({
				...session,
				title: session.title ?? undefined,
				engine: session.engine ?? 'claude-code',
				model: session.model ?? undefined,
				latest_sdk_session_id: session.latest_sdk_session_id ?? undefined,
				current_head_message_id: session.current_head_message_id ?? undefined,
				ended_at: session.ended_at ?? undefined
			})),
			currentSessionId: currentSessionId ?? undefined
		};
	})

	// List active (non-ended) sessions for current project
	.http('sessions:list-active', {
		data: t.Object({}),
		response: t.Array(t.Object({
			id: t.String(),
			project_id: t.String(),
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
			model: t.Optional(t.String()),
			latest_sdk_session_id: t.Optional(t.String()),
			current_head_message_id: t.Optional(t.String()),
			started_at: t.String(),
			ended_at: t.Optional(t.String())
		}))
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);
		const sessions = sessionQueries.getActiveSessionsForProject(projectId);

		return sessions.map(session => ({
			...session,
			title: session.title ?? undefined,
			engine: session.engine ?? 'claude-code',
			model: session.model ?? undefined,
			latest_sdk_session_id: session.latest_sdk_session_id ?? undefined,
			current_head_message_id: session.current_head_message_id ?? undefined,
			ended_at: session.ended_at ?? undefined
		}));
	})

	// Create new session
	.http('sessions:create', {
		data: t.Object({
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')]))
		}),
		response: t.Object({
			id: t.String(),
			project_id: t.String(),
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
			model: t.Optional(t.String()),
			latest_sdk_session_id: t.Optional(t.String()),
			current_head_message_id: t.Optional(t.String()),
			started_at: t.String(),
			ended_at: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const now = new Date().toISOString();
		const engine: EngineType = data.engine ?? 'claude-code';
		const session = sessionQueries.create({
			project_id: projectId,
			title: data.title || 'New Chat Session',
			engine,
			started_at: now
		});

		// Convert null to undefined for TypeScript optional fields
		return {
			...session,
			title: session.title ?? undefined,
			engine: session.engine ?? 'claude-code',
			model: session.model ?? undefined,
			latest_sdk_session_id: session.latest_sdk_session_id ?? undefined,
			current_head_message_id: session.current_head_message_id ?? undefined,
			ended_at: session.ended_at ?? undefined
		};
	})

	// Get session by ID (with messages)
	.http('sessions:get', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			session: t.Object({
				id: t.String(),
				project_id: t.String(),
				title: t.Optional(t.String()),
				engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
				model: t.Optional(t.String()),
				latest_sdk_session_id: t.Optional(t.String()),
				current_head_message_id: t.Optional(t.String()),
				started_at: t.String(),
				ended_at: t.Optional(t.String())
			}),
			messages: t.Array(t.Any())
		})
	}, async ({ data }) => {
		const session = sessionQueries.getById(data.id);

		if (!session) {
			throw new Error('Session not found');
		}

		// Also get messages for this session
		const messages = messageQueries.getBySessionId(data.id);

		// Convert null to undefined for TypeScript optional fields
		return {
			session: {
				...session,
				title: session.title ?? undefined,
				engine: session.engine ?? undefined,
				model: session.model ?? undefined,
				latest_sdk_session_id: session.latest_sdk_session_id ?? undefined,
				current_head_message_id: session.current_head_message_id ?? undefined,
				ended_at: session.ended_at ?? undefined
			},
			messages
		};
	})

	// Get or create shared session
	.http('sessions:get-shared', {
		data: t.Object({
			forceNew: t.Optional(t.Boolean())
		}),
		response: t.Object({
			id: t.String(),
			project_id: t.String(),
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
			model: t.Optional(t.String()),
			latest_sdk_session_id: t.Optional(t.String()),
			current_head_message_id: t.Optional(t.String()),
			started_at: t.String(),
			ended_at: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		// Get project details
		const project = projectQueries.getById(projectId);
		if (!project) {
			throw new Error('Project not found');
		}

		// Check if an active session already exists BEFORE get-or-create
		const existingActiveSession = (data.forceNew) ? null : sessionQueries.getActiveSessionForProject(projectId);

		// Get or create shared session
		const session = sessionQueries.getOrCreateSharedSession(
			projectId,
			project.name,
			data.forceNew || false
		);

		const sessionResponse = {
			...session,
			title: session.title ?? undefined,
			engine: session.engine ?? 'claude-code',
			model: session.model ?? undefined,
			latest_sdk_session_id: session.latest_sdk_session_id ?? undefined,
			current_head_message_id: session.current_head_message_id ?? undefined,
			ended_at: session.ended_at ?? undefined
		};

		// Broadcast when a NEW session was actually created.
		// Covers both forceNew=true and the case where no active session existed.
		// Other users do NOT auto-switch — they see the session in the session picker.
		const isNewlyCreated = !existingActiveSession || existingActiveSession.id !== session.id;
		if (isNewlyCreated) {
			debug.log('session', `Broadcasting new session available to project: ${projectId}`);
			ws.emit.project(projectId, 'sessions:session-available', {
				session: sessionResponse
			});
		}

		return sessionResponse;
	})

	// Update session
	.http('sessions:update', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			title: t.Optional(t.String()),
			reactivate: t.Optional(t.Boolean()),
			end_session: t.Optional(t.Boolean())
		}),
		response: t.Object({
			id: t.String(),
			project_id: t.String(),
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
			model: t.Optional(t.String()),
			latest_sdk_session_id: t.Optional(t.String()),
			current_head_message_id: t.Optional(t.String()),
			started_at: t.String(),
			ended_at: t.Optional(t.String())
		})
	}, async ({ data }) => {
		const session = sessionQueries.getById(data.id);
		if (!session) {
			throw new Error('Session not found');
		}

		// Update session title if provided
		if (data.title) {
			sessionQueries.updateTitle(data.id, data.title);
		}

		// Reactivate session if requested (clear ended_at and end other sessions in same project)
		if (data.reactivate) {
			sessionQueries.reactivate(data.id);
		}

		// End session if requested
		if (data.end_session) {
			sessionQueries.end(data.id);
		}

		const updatedSession = sessionQueries.getById(data.id)!;

		// Convert null to undefined for TypeScript optional fields
		return {
			...updatedSession,
			title: updatedSession.title ?? undefined,
			engine: updatedSession.engine ?? 'claude-code',
			model: updatedSession.model ?? undefined,
			latest_sdk_session_id: updatedSession.latest_sdk_session_id ?? undefined,
			current_head_message_id: updatedSession.current_head_message_id ?? undefined,
			ended_at: updatedSession.ended_at ?? undefined
		};
	})

	// Delete session
	.http('sessions:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const session = sessionQueries.getById(data.id);

		if (!session) {
			throw new Error('Session not found');
		}

		const projectId = session.project_id;
		sessionQueries.delete(data.id);

		// Broadcast to all project members so other users see the deletion
		debug.log('session', `Broadcasting session deleted: ${data.id} in project: ${projectId}`);
		ws.emit.project(projectId, 'sessions:session-deleted', {
			sessionId: data.id,
			projectId
		});

		return {
			message: 'Session deleted successfully'
		};
	})

	// Persist user's current session choice (for refresh restore)
	.on('sessions:set-current', {
		data: t.Object({
			sessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);
		projectQueries.setCurrentSessionId(userId, projectId, data.sessionId);
		debug.log('session', `User ${userId} set current session to ${data.sessionId} in project ${projectId}`);
	});
