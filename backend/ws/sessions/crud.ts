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
import { sessionQueries, messageQueries, projectQueries, snapshotQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { streamManager } from '../../chat/stream-manager';
import { snapshotService } from '../../snapshot/snapshot-service';
import { blobStore } from '../../snapshot/blob-store';
import { broadcastPresence } from '../projects/status';
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
			currentSessionId: t.Optional(t.String()),
			unreadSessionIds: t.Array(t.Object({
				sessionId: t.String(),
				projectId: t.String()
			}))
		})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);
		const sessions = sessionQueries.getByProjectId(projectId);

		// Get the user's saved current session for this project
		const currentSessionId = projectQueries.getCurrentSessionId(userId, projectId);

		// Get unread sessions for this user/project
		const unreadRows = sessionQueries.getUnreadSessions(userId, projectId);
		debug.log('session', `[unread] sessions:list — user=${userId}, project=${projectId}, unreadCount=${unreadRows.length}`, unreadRows);

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
			currentSessionId: currentSessionId ?? undefined,
			unreadSessionIds: unreadRows.map(r => ({ sessionId: r.session_id, projectId: r.project_id }))
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

	// Delete session (with full related data cleanup)
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

		// Cancel and clean up any active/completed streams for this session
		await streamManager.cleanupSessionStreams(data.id);

		// Collect ALL blob hashes before deleting anything:
		// 1. In-memory baseline hashes (all project files hashed at session start)
		const baselineHashes = snapshotService.getSessionBaselineHashes(data.id);
		// 2. DB snapshot delta hashes (including soft-deleted snapshots)
		const allSnapshots = snapshotQueries.getAllBySessionId(data.id);
		const deltaHashes = snapshotQueries.collectBlobHashes(allSnapshots);
		// Combine both sources
		const hashesToCheck = new Set([...baselineHashes, ...deltaHashes]);

		debug.log('session', `Session ${data.id}: ${baselineHashes.size} baseline hashes, ${deltaHashes.size} delta hashes, ${hashesToCheck.size} total unique`);

		// Clear in-memory snapshot baseline
		snapshotService.clearSessionBaseline(data.id);

		// Delete session and all related DB data (messages, snapshots, branches, relationships, unread)
		sessionQueries.delete(data.id);

		// Clean up orphaned blobs — protect hashes still used by other active sessions
		if (hashesToCheck.size > 0) {
			const stillReferencedByDB = snapshotQueries.getAllReferencedBlobHashes();
			const stillReferencedByMemory = snapshotService.getAllBaselineHashes();
			const orphanHashes = [...hashesToCheck].filter(
				h => !stillReferencedByDB.has(h) && !stillReferencedByMemory.has(h)
			);
			if (orphanHashes.length > 0) {
				const deleted = await blobStore.deleteBlobs(orphanHashes);
				debug.log('session', `Cleaned up ${deleted}/${orphanHashes.length} orphaned blobs`);
			}
		}

		// Broadcast to all project members so other users see the deletion
		debug.log('session', `Broadcasting session deleted: ${data.id} in project: ${projectId}`);
		ws.emit.project(projectId, 'sessions:session-deleted', {
			sessionId: data.id,
			projectId
		});

		// Broadcast updated presence so status indicators reflect the deletion
		broadcastPresence().catch(() => {});

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
		const projectId = ws.getProjectId(conn);

		// Get all sessions for this project to clean up streams
		const sessions = sessionQueries.getByProjectId(projectId);
		if (sessions.length === 0) {
			return { message: 'No sessions to delete', deletedCount: 0 };
		}

		// Cancel and clean up active streams for all sessions
		await Promise.all(
			sessions.map(s => streamManager.cleanupSessionStreams(s.id).catch(() => {}))
		);

		// Collect ALL blob hashes before deleting anything:
		// 1. In-memory baseline hashes from all sessions
		const baselineHashes = new Set<string>();
		for (const s of sessions) {
			for (const h of snapshotService.getSessionBaselineHashes(s.id)) {
				baselineHashes.add(h);
			}
		}
		// 2. DB snapshot delta hashes (including soft-deleted)
		const allSnapshots = snapshotQueries.getAllByProjectId(projectId);
		const deltaHashes = snapshotQueries.collectBlobHashes(allSnapshots);
		// Combine both sources
		const hashesToCheck = new Set([...baselineHashes, ...deltaHashes]);

		debug.log('session', `Project ${projectId}: ${baselineHashes.size} baseline hashes, ${deltaHashes.size} delta hashes, ${hashesToCheck.size} total unique`);

		// Clear in-memory snapshot baselines for all sessions
		for (const s of sessions) {
			snapshotService.clearSessionBaseline(s.id);
		}

		// Delete all sessions and related DB data (messages, snapshots, branches, relationships, unread)
		const deletedIds = sessionQueries.deleteAllByProjectId(projectId);

		// Clean up orphaned blobs using mark-and-sweep GC:
		// Scan ALL blobs on disk, keep those still referenced by remaining DB snapshots
		// or by in-memory baselines of other active sessions (other projects)
		const allBlobsOnDisk = await blobStore.scanAllBlobHashes();
		const stillReferencedByDB = snapshotQueries.getAllReferencedBlobHashes();
		const stillReferencedByMemory = snapshotService.getAllBaselineHashes();

		const blobsToDelete = [...allBlobsOnDisk].filter(
			h => !stillReferencedByDB.has(h) && !stillReferencedByMemory.has(h)
		);

		if (blobsToDelete.length > 0) {
			const deleted = await blobStore.deleteBlobs(blobsToDelete);
			debug.log('session', `Cleaned up ${deleted}/${blobsToDelete.length} orphaned blobs (full GC after bulk delete)`);
		}

		// Broadcast deletion for each session so all connected users update their state
		for (const sessionId of deletedIds) {
			ws.emit.project(projectId, 'sessions:session-deleted', {
				sessionId,
				projectId
			});
		}

		broadcastPresence().catch(() => {});

		debug.log('session', `Deleted all ${deletedIds.length} sessions in project: ${projectId}`);
		return {
			message: `Deleted ${deletedIds.length} sessions`,
			deletedCount: deletedIds.length
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
	})

	// Mark a session as read for the current user
	.on('sessions:mark-read', {
		data: t.Object({
			sessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		sessionQueries.markRead(userId, data.sessionId);
		debug.log('session', `[unread] Marked session ${data.sessionId} as READ for user ${userId}`);
	})

	// Mark a session as unread for the current user
	.on('sessions:mark-unread', {
		data: t.Object({
			sessionId: t.String(),
			projectId: t.String()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		sessionQueries.markUnread(userId, data.sessionId, data.projectId);
		debug.log('session', `[unread] Marked session ${data.sessionId} as UNREAD for user ${userId} in project ${data.projectId}`);
	});
