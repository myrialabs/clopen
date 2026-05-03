/**
 * Snapshot Restore Handler (v2 - Session-Scoped with Conflict Detection)
 *
 * Two-phase restore:
 * 1. Check conflicts: detect files modified by other sessions
 * 2. Execute restore: undo session-scoped changes, respecting conflict resolutions
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries, sessionQueries, projectQueries, checkpointQueries } from '../../database/queries';
import { snapshotService } from '../../snapshot/snapshot-service';
import { debug } from '$shared/utils/logger';
import type { UnifiedMessage } from '$shared/types/unified';
import {
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findCheckpointForHead,
	findSessionEnd,
	INITIAL_NODE_ID
} from '../../snapshot/helpers';
import { ws } from '$backend/utils/ws';
import { requireSessionAccess } from '../access';

export const restoreHandler = createRouter()
	/**
	 * Phase 1: Check for conflicts before restore.
	 * Frontend calls this first, and if conflicts exist, shows a modal.
	 */
	.http('snapshot:check-conflicts', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			hasConflicts: t.Boolean(),
			conflicts: t.Array(t.Object({
				filepath: t.String(),
				modifiedBySessionId: t.String(),
				modifiedBySnapshotId: t.String(),
				modifiedAt: t.String(),
				restoreContent: t.Optional(t.String()),
				currentContent: t.Optional(t.String())
			})),
			checkpointsToUndo: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		const { messageId, sessionId } = data;
		requireSessionAccess(conn, sessionId);

		debug.log('snapshot', `Checking restore conflicts for checkpoint ${messageId} in session ${sessionId}`);

		// Resolve project path for reading file contents
		let projectPath: string | undefined;
		const session = sessionQueries.getById(sessionId);
		if (session) {
			const project = projectQueries.getById(session.project_id);
			if (project) projectPath = project.path;
		}

		// Build checkpoint path for branch-aware conflict detection
		let targetPath: string[] | undefined;
		let resolvedMessageId: string | null = messageId === INITIAL_NODE_ID ? null : messageId;

		if (messageId !== INITIAL_NODE_ID) {
			const allMessages = messageQueries.getAllBySessionId(sessionId);
			const { checkpoints, parentMap } = buildCheckpointTree(allMessages);
			const checkpointIdSet = new Set(checkpoints.map(c => c.id));

			const resolvedId = checkpointIdSet.has(messageId)
				? messageId
				: findCheckpointForHead(messageId, allMessages, checkpointIdSet);

			if (resolvedId) {
				resolvedMessageId = resolvedId;
				targetPath = getCheckpointPathToRoot(resolvedId, parentMap);
			}
		}

		const result = await snapshotService.checkRestoreConflicts(
			sessionId,
			resolvedMessageId,
			projectPath,
			targetPath
		);

		debug.log('snapshot', `Conflict check: ${result.conflicts.length} conflicts, ${result.checkpointsToUndo.length} checkpoints to undo`);

		return result;
	})

	/**
	 * Phase 2: Execute restore with optional conflict resolutions.
	 */
	.http('snapshot:restore', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String(),
			conflictResolutions: t.Optional(t.Record(t.String(), t.Union([
				t.Literal('restore'),
				t.Literal('keep')
			])))
		}),
		response: t.Object({
			restoredTo: t.Object({
				messageId: t.String(),
				timestamp: t.String()
			}),
			filesRestored: t.Optional(t.Number()),
			filesSkipped: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const { messageId, sessionId, conflictResolutions } = data;
		requireSessionAccess(conn, sessionId);
		const isInitialRestore = messageId === INITIAL_NODE_ID;

		debug.log('snapshot', `RESTORE - ${isInitialRestore ? 'Restoring to initial state' : 'Moving HEAD to checkpoint'}`);
		debug.log('snapshot', `Target: ${messageId}`);
		debug.log('snapshot', `Session: ${sessionId}`);

		// Handle restore to initial state (before any messages)
		if (isInitialRestore) {
			// Clear HEAD (no messages active)
			sessionQueries.clearHead(sessionId);
			sessionQueries.rederiveHeadSnapshot(sessionId);
			debug.log('snapshot', 'HEAD cleared (initial state)');

			// Clear head_session_id so next chat starts fresh
			const db = (await import('../../database')).getDatabase();
			db.prepare(`UPDATE chat_sessions SET head_session_id = NULL WHERE id = ?`).run(sessionId);

			// Clear checkpoint_tree_state
			checkpointQueries.deleteForSession(sessionId);

			// Restore file system: revert ALL session changes
			let filesRestored = 0;
			let filesSkipped = 0;

			const session = sessionQueries.getById(sessionId);
			if (session) {
				const project = projectQueries.getById(session.project_id);
				if (project) {
					const result = await snapshotService.restoreSessionScoped(
						project.path,
						sessionId,
						null, // null = restore to initial (before all snapshots)
						conflictResolutions
					);
					filesRestored = result.restoredFiles;
					filesSkipped = result.skippedFiles;
				}
			}

			// Broadcast messages-changed
			try {
				ws.emit.chatSession(sessionId, 'chat:messages-changed', {
					sessionId,
					reason: 'restore',
					timestamp: new Date().toISOString()
				});
			} catch (err) {
				debug.error('snapshot', 'Failed to broadcast messages-changed:', err);
			}

			return {
				restoredTo: {
					messageId: INITIAL_NODE_ID,
					timestamp: new Date().toISOString()
				},
				filesRestored,
				filesSkipped
			};
		}

		// Regular checkpoint restore
		// 1. Get the target message
		const checkpointMessage = messageQueries.getById(messageId);
		if (!checkpointMessage) {
			throw new Error('Checkpoint message not found');
		}

		// 2. Get current HEAD
		const currentHead = sessionQueries.getHead(sessionId);
		debug.log('snapshot', `Current HEAD: ${currentHead}`);

		// 3. Get all messages and build checkpoint tree
		const allMessages = messageQueries.getAllBySessionId(sessionId);
		const { checkpoints, parentMap } = buildCheckpointTree(allMessages);

		// 3b. Resolve the correct checkpoint for snapshot/tree operations
		// The target message may be a non-checkpoint (e.g., assistant response)
		// when called from edit mode. Walk back to find the nearest ancestor checkpoint.
		const checkpointIdSet = new Set(checkpoints.map(c => c.id));
		const resolvedCheckpointId = checkpointIdSet.has(messageId)
			? messageId
			: findCheckpointForHead(messageId, allMessages, checkpointIdSet);

		debug.log('snapshot', `Resolved checkpoint: ${resolvedCheckpointId} (target was ${messageId})`);

		// 4. Find session end (last message of target's session)
		const sessionEnd = findSessionEnd(checkpointMessage, allMessages);
		debug.log('snapshot', `Session end: ${sessionEnd.id}`);

		// 5. Update HEAD to session end
		sessionQueries.updateHead(sessionId, sessionEnd.id);
		sessionQueries.rederiveHeadSnapshot(sessionId);
		debug.log('snapshot', `HEAD updated to: ${sessionEnd.id}`);

		// 5b. Update head_session_id so resume works correctly.
		// Claude Code: skip cancelled fork session_ids (partial messages from cancelStream).
		// OpenCode: simple walk — any session_id is valid (sessions created synchronously).
		{
			let foundSdkSessionId: string | null = null;
			const msgLookup = new Map(allMessages.map(m => [m.id, m]));
			const sessionRecord = sessionQueries.getById(sessionId);
			const isClaudeCode = sessionRecord?.engine === 'claude-code';

			// Claude Code only: detect cancelled stream by stopReason on sessionEnd
			let cancelledSessionId: string | null = null;
			if (isClaudeCode) {
				try {
					const endMsg = msgLookup.get(sessionEnd.id);
					if (endMsg) {
						const endParsed = JSON.parse(endMsg.data) as UnifiedMessage;
						if (endParsed.type === 'assistant' && endParsed.stopReason === 'interrupted') {
							cancelledSessionId = endParsed.sessionId || null;
						}
					}
				} catch { /* skip */ }
			}

			let walkId: string | null = sessionEnd.id;
			while (walkId) {
				const walkMsg = msgLookup.get(walkId);
				if (!walkMsg) break;

				try {
					const msg = JSON.parse(walkMsg.data) as UnifiedMessage;

					// Claude Code only: skip interrupted messages (from cancelled streams)
					if (isClaudeCode && msg.type === 'assistant' && msg.stopReason === 'interrupted') {
						walkId = walkMsg.parent_message_id || null;
						continue;
					}

					// Claude Code only: skip messages from the same cancelled fork
					if (isClaudeCode && cancelledSessionId && msg.sessionId === cancelledSessionId) {
						walkId = walkMsg.parent_message_id || null;
						continue;
					}

					// Any engine: message with sessionId
					if (msg.sessionId) {
						foundSdkSessionId = msg.sessionId;
						break;
					}
				} catch { /* skip */ }

				walkId = walkMsg.parent_message_id || null;
			}

			if (foundSdkSessionId) {
				sessionQueries.updateSessionId(sessionId, foundSdkSessionId);
				debug.log('snapshot', `head_session_id updated to: ${foundSdkSessionId}`);
			} else {
				sessionQueries.clearSessionId(sessionId);
				debug.log('snapshot', 'head_session_id cleared (no valid session found in restored chain)');
			}
		}

		// 6. Update checkpoint_tree_state for ancestors
		// Use resolved checkpoint ID (not raw messageId which may be a non-checkpoint)
		// Also compute checkpointPath for branch-aware file restore
		let checkpointPath: string[] = [];
		if (resolvedCheckpointId) {
			checkpointPath = getCheckpointPathToRoot(resolvedCheckpointId, parentMap);
			if (checkpointPath.length > 1) {
				checkpointQueries.updateActiveChildrenAlongPath(sessionId, checkpointPath);
			}
		}

		// 7. Restore file system state using session-scoped restore
		// Use resolved checkpoint ID so the snapshot lookup matches correctly
		// (snapshots are keyed by checkpoint user message IDs, not assistant messages)
		let filesRestored = 0;
		let filesSkipped = 0;

		const session = sessionQueries.getById(sessionId);
		if (session) {
			const project = projectQueries.getById(session.project_id);
			if (project) {
				const result = await snapshotService.restoreSessionScoped(
					project.path,
					sessionId,
					resolvedCheckpointId,
					conflictResolutions,
					checkpointPath.length > 0 ? checkpointPath : undefined
				);
				filesRestored = result.restoredFiles;
				filesSkipped = result.skippedFiles;
			}
		}

		// 8. Broadcast messages-changed
		try {
			ws.emit.chatSession(sessionId, 'chat:messages-changed', {
				sessionId,
				reason: 'restore',
				timestamp: new Date().toISOString()
			});
		} catch (err) {
			debug.error('snapshot', 'Failed to broadcast messages-changed:', err);
		}

		return {
			restoredTo: {
				messageId: sessionEnd.id,
				timestamp: sessionEnd.created_at
			},
			filesRestored,
			filesSkipped
		};
	});
