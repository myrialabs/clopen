/**
 * Sessions CRUD Operations
 *
 * HTTP endpoints for session management:
 * - List sessions (all or by project)
 * - Create new session
 * - Get session by ID
 * - Get or create shared session
 * - Update session (title, reactivate, end)
 * - Delete session
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { EngineType } from '$shared/types/unified';
import type { ChatSession } from '$shared/types/database/schema';
import { sessionQueries, projectQueries, worktreeQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { purgeSessions } from '../../storage/purge';
import { broadcastPresence } from '../projects/status';
import { debug } from '$shared/utils/logger';
import { requireCurrentProjectAccess, requireProjectAccess, requireSessionAccess } from '../access';

/** Elysia schema for ChatSession responses — all optional fields use t.Optional */
const sessionSchema = t.Object({
	// Identity
	id: t.String(),
	project_id: t.String(),
	started_at: t.String(),
	ended_at: t.Optional(t.String()),
	// Session preferences
	title: t.Optional(t.String()),
	engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen'), t.Literal('pi'), t.Literal('cline'), t.Literal('cursor')])),
	model_id: t.Optional(t.String()),
	model_name: t.Optional(t.String()),
	account_id: t.Optional(t.Number()),
	account_name: t.Optional(t.String()),
	// HEAD state
	head_message_id: t.Optional(t.String()),
	head_session_id: t.Optional(t.String()),
	head_title: t.Optional(t.String()),
	head_summary: t.Optional(t.String()),
	// Isolation
	worktree_id: t.Optional(t.Union([t.String(), t.Null()])),
	// Activity tracking
	message_count: t.Optional(t.Number()),
	user_count: t.Optional(t.Number()),
	last_message_at: t.Optional(t.String()),
});

/** sessionSchema plus a highlighted match snippet — global (cross-project) search only. */
const sessionSearchResultSchema = t.Object({
	...sessionSchema.properties,
	matchSnippet: t.Optional(t.String())
});

/** Convert ChatSession DB row → response (null → undefined for Elysia optional fields) */
function serializeSession(session: ChatSession) {
	return {
		...session,
		title: session.title ?? undefined,
		engine: session.engine ?? 'claude-code' as const,
		model_id: session.model_id ?? undefined,
		model_name: session.model_name ?? undefined,
		account_id: session.account_id ?? undefined,
		account_name: session.account_name ?? undefined,
		head_message_id: session.head_message_id ?? undefined,
		head_session_id: session.head_session_id ?? undefined,
		ended_at: session.ended_at ?? undefined,
		head_title: session.head_title ?? undefined,
		head_summary: session.head_summary ?? undefined,
		message_count: session.message_count ?? undefined,
		user_count: session.user_count ?? undefined,
		last_message_at: session.last_message_at ?? undefined,
		worktree_id: session.worktree_id ?? null,
	};
}

/** Validate a requested worktree belongs to this project; anything else is main. */
function resolveRequestedWorktree(projectId: string, worktreeId: string | null | undefined): string | null {
	if (!worktreeId) return null;
	const worktree = worktreeQueries.getById(worktreeId);
	return worktree && worktree.project_id === projectId ? worktree.id : null;
}

export const crudHandler = createRouter()
	// List sessions (includes server-saved current session ID for refresh restore)
	.http('sessions:list', {
		data: t.Object({}),
		response: t.Object({
			sessions: t.Array(sessionSchema),
			currentSessionId: t.Optional(t.String()),
			unreadSessionIds: t.Array(t.Object({
				sessionId: t.String(),
				projectId: t.String()
			}))
		})
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		const sessions = sessionQueries.getByProjectId(projectId);

		// The saved current session for this project
		const currentSessionId = projectQueries.getCurrentSessionId(projectId);

		const unreadRows = sessionQueries.getUnreadSessions(projectId);
		debug.log('session', `[unread] sessions:list — project=${projectId}, unreadCount=${unreadRows.length}`, unreadRows);

		return {
			sessions: sessions.map(serializeSession),
			currentSessionId: currentSessionId ?? undefined,
			unreadSessionIds: unreadRows.map(r => ({ sessionId: r.session_id, projectId: r.project_id }))
		};
	})

	// List active (non-ended) sessions for current project
	.http('sessions:list-active', {
		data: t.Object({}),
		response: t.Array(sessionSchema)
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		const sessions = sessionQueries.getActiveSessionsForProject(projectId);
		return sessions.map(serializeSession);
	})

	// Create new session
	.http('sessions:create', {
		data: t.Object({
			title: t.Optional(t.String()),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen'), t.Literal('pi'), t.Literal('cline'), t.Literal('cursor')])),
			worktreeId: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: sessionSchema
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		const now = new Date().toISOString();
		const engine: EngineType = data.engine ?? 'claude-code';
		const session = sessionQueries.create({
			project_id: projectId,
			title: data.title || 'New Chat Session',
			engine,
			started_at: now,
			worktree_id: resolveRequestedWorktree(projectId, data.worktreeId)
		});

		return serializeSession(session);
	})

	// Get session by ID.
	//
	// The session only. It used to carry the whole message chain as well, which
	// no caller read — opening a chat loads its messages through `messages:list`
	// right after — so every chat open downloaded its entire history twice.
	.http('sessions:get', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			session: sessionSchema
		})
	}, async ({ data }) => {
		const session = requireSessionAccess(data.id);
		return { session: serializeSession(session) };
	})

	// Get or create shared session
	.http('sessions:get-shared', {
		data: t.Object({
			forceNew: t.Optional(t.Boolean()),
			worktreeId: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: sessionSchema
	}, async ({ data, conn }) => {
		const { projectId, project } = requireCurrentProjectAccess(conn);
		const worktreeId = resolveRequestedWorktree(projectId, data.worktreeId);

		// Check if an active session already exists BEFORE get-or-create
		const existingActiveSession = (data.forceNew) ? null : sessionQueries.getActiveSessionForProject(projectId, worktreeId);

		// Get or create shared session
		const session = sessionQueries.getOrCreateSharedSession(
			projectId,
			project.name,
			data.forceNew || false,
			worktreeId
		);

		const sessionResponse = serializeSession(session);

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
		response: sessionSchema
	}, async ({ data }) => {
		requireSessionAccess(data.id);

		if (data.title) {
			sessionQueries.updateTitle(data.id, data.title);
		}

		if (data.reactivate) {
			sessionQueries.reactivate(data.id);
		}

		if (data.end_session) {
			sessionQueries.end(data.id);
		}

		const updatedSession = sessionQueries.getById(data.id)!;
		return serializeSession(updatedSession);
	})

	// Delete session (with full related data cleanup)
	.http('sessions:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data }) => {
		const session = requireSessionAccess(data.id);

		const projectId = session.project_id;

		// Streams, snapshot blobs, memory bookkeeping and the engine's own
		// transcript all go through the shared purge.
		await purgeSessions([data.id]);

		// Broadcast to the project so other devices see the deletion
		debug.log('session', `Broadcasting session deleted: ${data.id} in project: ${projectId}`);
		ws.emit.project(projectId, 'sessions:session-deleted', {
			sessionId: data.id,
			projectId
		});

		// Broadcast updated presence so status indicators reflect the deletion
		broadcastPresence().catch((err) => {
			debug.warn('session', 'Presence broadcast error after session deletion:', err);
		});

		return {
			message: 'Session deleted successfully'
		};
	})

	// Delete all sessions for the current project (with full cleanup)
	.http('sessions:delete-all', {
		data: t.Object({}),
		response: t.Object({
			message: t.String(),
			deletedCount: t.Number()
		})
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);

		if (sessionQueries.getByProjectId(projectId).length === 0) {
			return { message: 'No sessions to delete', deletedCount: 0 };
		}

		const { deletedIds } = await purgeSessions([], { wholeProject: projectId });

		// Broadcast deletion for each session so all connected users update their state
		for (const sessionId of deletedIds) {
			ws.emit.project(projectId, 'sessions:session-deleted', {
				sessionId,
				projectId
			});
		}

		broadcastPresence().catch((err) => {
			debug.warn('session', 'Presence broadcast error after bulk session deletion:', err);
		});

		debug.log('session', `Deleted all ${deletedIds.length} sessions in project: ${projectId}`);
		return {
			message: `Deleted ${deletedIds.length} sessions`,
			deletedCount: deletedIds.length
		};
	})

	// Persist the current session choice (for refresh restore)
	.on('sessions:set-current', {
		data: t.Object({
			sessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		requireSessionAccess(data.sessionId);
		projectQueries.setCurrentSessionId(projectId, data.sessionId);
		debug.log('session', `Current session set to ${data.sessionId} in project ${projectId}`);
	})

	.on('sessions:mark-read', {
		data: t.Object({
			sessionId: t.String()
		})
	}, async ({ data }) => {
		requireSessionAccess(data.sessionId);
		sessionQueries.markRead(data.sessionId);
		debug.log('session', `[unread] Marked session ${data.sessionId} as READ`);
	})

	.on('sessions:mark-unread', {
		data: t.Object({
			sessionId: t.String(),
			projectId: t.String()
		})
	}, async ({ data }) => {
		const session = requireSessionAccess(data.sessionId);
		requireProjectAccess(data.projectId);
		if (session.project_id !== data.projectId) {
			throw new Error('Access denied');
		}
		sessionQueries.markUnread(data.sessionId, data.projectId);
		debug.log('session', `[unread] Marked session ${data.sessionId} as UNREAD in project ${data.projectId}`);
	})

	// Mark every session in a project as read
	.on('sessions:mark-all-read', {
		data: t.Object({
			projectId: t.String()
		})
	}, async ({ data }) => {
		requireProjectAccess(data.projectId);
		sessionQueries.markAllRead(data.projectId);
		debug.log('session', `[unread] Marked ALL sessions as READ in project ${data.projectId}`);
	})

	// Search sessions by message content within the current project (deep search)
	.http('sessions:search', {
		data: t.Object({
			query: t.String({ minLength: 1 })
		}),
		response: t.Object({
			results: t.Array(t.Object({
				sessionId: t.String(),
				snippet: t.String()
			}))
		})
	}, async ({ data, conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		const results = sessionQueries.searchByMessageContent(projectId, data.query);
		return { results };
	})

	// Search sessions across every project in the workspace list (Command Palette)
	.http('sessions:search-global', {
		data: t.Object({
			query: t.String({ minLength: 1 })
		}),
		response: t.Object({
			sessions: t.Array(sessionSearchResultSchema)
		})
	}, async ({ data }) => {
		const results = sessionQueries.searchGlobal(data.query);
		return {
			sessions: results.map(r => ({ ...serializeSession(r), matchSnippet: r.matchSnippet }))
		};
	});
