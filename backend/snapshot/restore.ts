/**
 * Restore a chat session to a checkpoint — HEAD, engine resume id, checkpoint
 * tree and files, in one call.
 *
 * This used to live inline in the `snapshot:restore` WebSocket handler, which
 * made the web UI the only thing that could branch a conversation. A chat
 * channel replying to an older message, or editing one, needs exactly the
 * same operation without a connection, so the logic lives here and the
 * handler is a thin wrapper. Any change to what "restore" means is made once.
 */

import { messageQueries, sessionQueries, checkpointQueries } from '../database/queries';
import { getDatabase } from '../database';
import { snapshotService } from './snapshot-service';
import { streamManager } from '../chat/stream-manager';
import { debug } from '$shared/utils/logger';
import type { UnifiedMessage } from '$shared/types/unified';
import {
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findCheckpointForHead,
	findSessionEnd,
	INITIAL_NODE_ID
} from './helpers';
import { ws } from '$backend/utils/ws';
import { resolveSessionRoot } from '../worktrees';

export type ConflictResolutions = Record<string, 'restore' | 'keep'>;

export interface RestoreResult {
	restoredTo: { messageId: string; timestamp: string };
	filesRestored: number;
	filesSkipped: number;
}

/** The checkpoint a target resolves to, and the checkpoint path for branch-aware file work. */
function resolveCheckpoint(sessionId: string, messageId: string): { checkpointId: string | null; path: string[] | undefined } {
	if (messageId === INITIAL_NODE_ID) return { checkpointId: null, path: undefined };
	const allMessages = messageQueries.getAllBySessionId(sessionId);
	const { checkpoints, parentMap } = buildCheckpointTree(allMessages);
	const checkpointIdSet = new Set(checkpoints.map((c) => c.id));
	const resolvedId = checkpointIdSet.has(messageId) ? messageId : findCheckpointForHead(messageId, allMessages, checkpointIdSet);
	return resolvedId
		? { checkpointId: resolvedId, path: getCheckpointPathToRoot(resolvedId, parentMap) }
		: { checkpointId: messageId, path: undefined };
}

/** Files another session (or the user) changed that restoring to `messageId` would overwrite. */
export async function checkSessionRestoreConflicts(sessionId: string, messageId: string) {
	const projectPath = resolveSessionRoot(sessionId)?.path || undefined;
	const { checkpointId, path } = resolveCheckpoint(sessionId, messageId);
	return snapshotService.checkRestoreConflicts(sessionId, checkpointId, projectPath, path);
}

/**
 * The message a restore to `messageId` would leave HEAD on — the end of that
 * message's turn. Lets a caller tell "continue from HEAD" (no restore at all)
 * apart from "branch from an older point" before doing anything.
 */
export function restoreTargetEnd(sessionId: string, messageId: string): string | null {
	if (messageId === INITIAL_NODE_ID) return null;
	const target = messageQueries.getById(messageId);
	if (!target || target.session_id !== sessionId) return null;
	return findSessionEnd(target, messageQueries.getAllBySessionId(sessionId)).id;
}

function broadcastRestored(sessionId: string): void {
	try {
		ws.emit.chatSession(sessionId, 'chat:messages-changed', {
			sessionId,
			reason: 'restore',
			timestamp: new Date().toISOString()
		});
	} catch (err) {
		debug.error('snapshot', 'Failed to broadcast messages-changed:', err);
	}
}

/**
 * Move a session back to `messageId` (or to before its first message, with
 * `INITIAL_NODE_ID`) and restore its files to match. Refuses while the
 * session is generating: restore rewrites the working tree and resets the
 * in-memory baseline, and doing that mid-stream would corrupt the end-of-turn
 * snapshot and race the engine's own writes.
 */
export async function restoreSessionTo(
	sessionId: string,
	messageId: string,
	conflictResolutions?: ConflictResolutions
): Promise<RestoreResult> {
	const session = sessionQueries.getById(sessionId);
	if (!session) throw new Error('Session not found');

	const activeStream = streamManager.getSessionStream(sessionId, session.project_id);
	if (activeStream?.status === 'active') {
		throw new Error('Cannot restore while the chat is still generating. Stop the stream first, then try again.');
	}

	const isInitialRestore = messageId === INITIAL_NODE_ID;
	debug.log('snapshot', `RESTORE - ${isInitialRestore ? 'Restoring to initial state' : 'Moving HEAD to checkpoint'} (${messageId}) in ${sessionId}`);

	if (isInitialRestore) {
		sessionQueries.clearHead(sessionId);
		sessionQueries.rederiveHeadSnapshot(sessionId);
		// Clear head_session_id so the next chat starts fresh.
		getDatabase().prepare(`UPDATE chat_sessions SET head_session_id = NULL WHERE id = ?`).run(sessionId);
		checkpointQueries.deleteForSession(sessionId);

		let filesRestored = 0;
		let filesSkipped = 0;
		const sessionRoot = resolveSessionRoot(sessionId);
		if (sessionRoot?.path) {
			// null = restore to initial (before all snapshots): revert ALL session changes.
			const result = await snapshotService.restoreSessionScoped(sessionRoot.path, sessionId, null, conflictResolutions);
			filesRestored = result.restoredFiles;
			filesSkipped = result.skippedFiles;
		}
		broadcastRestored(sessionId);
		return { restoredTo: { messageId: INITIAL_NODE_ID, timestamp: new Date().toISOString() }, filesRestored, filesSkipped };
	}

	// 1. The target message.
	const checkpointMessage = messageQueries.getById(messageId);
	if (!checkpointMessage) throw new Error('Checkpoint message not found');

	// 2-3. Every message, and the checkpoint tree built from them.
	const allMessages = messageQueries.getAllBySessionId(sessionId);
	const { checkpoints, parentMap } = buildCheckpointTree(allMessages);

	// 3b. The target may be a non-checkpoint (e.g. an assistant response, which
	// is what an edit targets): walk back to the nearest ancestor checkpoint.
	const checkpointIdSet = new Set(checkpoints.map((c) => c.id));
	const resolvedCheckpointId = checkpointIdSet.has(messageId)
		? messageId
		: findCheckpointForHead(messageId, allMessages, checkpointIdSet);

	// 4-5. HEAD moves to the end of the target's turn.
	const sessionEnd = findSessionEnd(checkpointMessage, allMessages);
	sessionQueries.updateHead(sessionId, sessionEnd.id);
	sessionQueries.rederiveHeadSnapshot(sessionId);
	debug.log('snapshot', `HEAD updated to: ${sessionEnd.id}`);

	// 5b. head_session_id, so resume works. Engine is read PER MESSAGE, not from
	// `chat_sessions.engine`: a session can switch engine mid-conversation, so
	// the session column only names the currently selected engine. Restoring
	// into a region driven by another engine must apply that region's
	// semantics, and must not adopt an SDK session id from another store.
	// Claude Code: skip cancelled fork session ids (partial messages from
	// cancelStream). Other engines: any session id on the branch is valid.
	{
		let foundSdkSessionId: string | null = null;
		const msgLookup = new Map(allMessages.map((m) => [m.id, m]));
		const engineOf = (msg: UnifiedMessage): string | null => msg.engine?.type ?? null;

		let branchEngine: string | null = null;
		{
			let probeId: string | null = sessionEnd.id;
			while (probeId) {
				const probeMsg = msgLookup.get(probeId);
				if (!probeMsg) break;
				try {
					const msg = JSON.parse(probeMsg.data) as UnifiedMessage;
					if (msg.type !== 'user') {
						const type = engineOf(msg);
						if (type) {
							branchEngine = type;
							break;
						}
					}
				} catch {
					/* skip */
				}
				probeId = probeMsg.parent_message_id || null;
			}
			if (!branchEngine) branchEngine = session.engine ?? null;
		}

		const isClaudeCode = branchEngine === 'claude-code';

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
			} catch {
				/* skip */
			}
		}

		let walkId: string | null = sessionEnd.id;
		while (walkId) {
			const walkMsg = msgLookup.get(walkId);
			if (!walkMsg) break;
			try {
				const msg = JSON.parse(walkMsg.data) as UnifiedMessage;
				if (isClaudeCode && msg.type === 'assistant' && msg.stopReason === 'interrupted') {
					walkId = walkMsg.parent_message_id || null;
					continue;
				}
				if (isClaudeCode && cancelledSessionId && msg.sessionId === cancelledSessionId) {
					walkId = walkMsg.parent_message_id || null;
					continue;
				}
				// A message with no engine block is pre-migration: it cannot be proven
				// foreign, so keep the old behaviour and accept it.
				const msgEngine = engineOf(msg);
				if (msg.sessionId && (!branchEngine || !msgEngine || msgEngine === branchEngine)) {
					foundSdkSessionId = msg.sessionId;
					break;
				}
			} catch {
				/* skip */
			}
			walkId = walkMsg.parent_message_id || null;
		}

		if (foundSdkSessionId) sessionQueries.updateSessionId(sessionId, foundSdkSessionId);
		else sessionQueries.clearSessionId(sessionId);
	}

	// 6. checkpoint_tree_state along the restored path.
	let checkpointPath: string[] = [];
	if (resolvedCheckpointId) {
		checkpointPath = getCheckpointPathToRoot(resolvedCheckpointId, parentMap);
		if (checkpointPath.length > 1) checkpointQueries.updateActiveChildrenAlongPath(sessionId, checkpointPath);
	}

	// 7. Files. Snapshots are keyed by checkpoint user message ids, so the
	// resolved checkpoint is what the lookup must use.
	let filesRestored = 0;
	let filesSkipped = 0;
	const sessionRoot = resolveSessionRoot(sessionId);
	if (sessionRoot?.path) {
		const result = await snapshotService.restoreSessionScoped(
			sessionRoot.path,
			sessionId,
			resolvedCheckpointId,
			conflictResolutions,
			checkpointPath.length > 0 ? checkpointPath : undefined
		);
		filesRestored = result.restoredFiles;
		filesSkipped = result.skippedFiles;
	}

	broadcastRestored(sessionId);
	return { restoredTo: { messageId: sessionEnd.id, timestamp: sessionEnd.created_at }, filesRestored, filesSkipped };
}
