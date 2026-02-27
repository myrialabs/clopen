/**
 * Snapshot Restore Handler (Unified - replaces undo.ts and redo.ts)
 *
 * Single restore operation that moves HEAD to any checkpoint.
 * Works identically regardless of whether the target is on the
 * current path, a branch, or an orphaned node.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries, sessionQueries, projectQueries, snapshotQueries, checkpointQueries } from '../../lib/database/queries';
import { snapshotService } from '../../lib/snapshot/snapshot-service';
import { debug } from '$shared/utils/logger';
import {
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findSessionEnd
} from '../../lib/snapshot/helpers';
import { ws } from '$backend/lib/utils/ws';

export const restoreHandler = createRouter()
	.http('snapshot:restore', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			restoredTo: t.Object({
				messageId: t.String(),
				timestamp: t.String()
			}),
			filesRestored: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const { messageId, sessionId } = data;

		debug.log('snapshot', 'RESTORE - Moving HEAD to checkpoint');
		debug.log('snapshot', `Target checkpoint: ${messageId}`);
		debug.log('snapshot', `Session: ${sessionId}`);

		// 1. Get the checkpoint message
		const checkpointMessage = messageQueries.getById(messageId);
		if (!checkpointMessage) {
			throw new Error('Checkpoint message not found');
		}

		// 2. Get current HEAD
		const currentHead = sessionQueries.getHead(sessionId);
		debug.log('snapshot', `Current HEAD: ${currentHead}`);

		// 3. Get all messages and build checkpoint tree
		const allMessages = messageQueries.getAllBySessionId(sessionId);
		const { parentMap } = buildCheckpointTree(allMessages);

		// 4. Find session end (last message of checkpoint's session)
		const sessionEnd = findSessionEnd(checkpointMessage, allMessages);
		const isSameAsCheckpoint = sessionEnd.id === messageId;
		debug.log('snapshot', `Session end: ${sessionEnd.id} (checkpoint: ${messageId}, sameAsCheckpoint: ${isSameAsCheckpoint})`);

		if (isSameAsCheckpoint) {
			debug.warn('snapshot', '⚠️ Session end is the SAME as checkpoint message! This means no assistant children were found.');
			debug.warn('snapshot', `Checkpoint parent_message_id: ${checkpointMessage.parent_message_id}`);
			// List all direct children of this checkpoint to debug
			const directChildren = allMessages.filter(m => m.parent_message_id === messageId);
			debug.warn('snapshot', `Direct children of checkpoint: ${directChildren.length}`);
			for (const child of directChildren) {
				try {
					const sdk = JSON.parse(child.sdk_message);
					debug.warn('snapshot', `  child=${child.id.slice(0, 8)} type=${sdk.type} ts=${child.timestamp}`);
				} catch {
					debug.warn('snapshot', `  child=${child.id.slice(0, 8)} (parse error)`);
				}
			}
		}

		// If session end is already HEAD, nothing to do (but still restore files)
		if (sessionEnd.id === currentHead) {
			debug.log('snapshot', 'Already at this checkpoint HEAD');
		}

		// 5. Update HEAD to session end
		sessionQueries.updateHead(sessionId, sessionEnd.id);
		debug.log('snapshot', `HEAD updated to: ${sessionEnd.id}`);

		// 5b. Update latest_sdk_session_id so resume works correctly
		// Walk backward from sessionEnd to find the last assistant message with session_id
		{
			let walkId: string | null = sessionEnd.id;
			let foundSdkSessionId: string | null = null;
			const msgLookup = new Map(allMessages.map(m => [m.id, m]));

			while (walkId) {
				const walkMsg = msgLookup.get(walkId);
				if (!walkMsg) break;

				try {
					const sdk = JSON.parse(walkMsg.sdk_message);
					if (sdk.session_id) {
						foundSdkSessionId = sdk.session_id;
						break;
					}
				} catch { /* skip */ }

				walkId = walkMsg.parent_message_id || null;
			}

			if (foundSdkSessionId) {
				sessionQueries.updateLatestSdkSessionId(sessionId, foundSdkSessionId);
				debug.log('snapshot', `latest_sdk_session_id updated to: ${foundSdkSessionId}`);
			} else {
				debug.warn('snapshot', 'Could not find SDK session_id for resume - resume may not work correctly');
			}
		}

		// 6. Update checkpoint_tree_state for ancestors
		const checkpointPath = getCheckpointPathToRoot(messageId, parentMap);
		if (checkpointPath.length > 1) {
			checkpointQueries.updateActiveChildrenAlongPath(sessionId, checkpointPath);
		}

		// 7. Restore file system state from snapshot
		// Walk backward from session end to checkpoint to find the best (most recent) snapshot
		let filesRestored = 0;
		const msgMap = new Map(allMessages.map(m => [m.id, m]));

		let snapshot = null;
		let walkId: string | null = sessionEnd.id;
		while (walkId) {
			const s = snapshotQueries.getByMessageId(walkId);
			if (s) {
				snapshot = s;
				break;
			}
			// Don't walk past the checkpoint message
			if (walkId === messageId) break;
			const walkMsg = msgMap.get(walkId);
			if (!walkMsg) break;
			walkId = walkMsg.parent_message_id || null;
		}

		debug.log('snapshot', `Snapshot found: ${snapshot ? `${snapshot.id} (for message ${snapshot.message_id})` : 'none'}`);

		if (snapshot) {
			const session = sessionQueries.getById(sessionId);
			if (session) {
				const project = projectQueries.getById(session.project_id);
				if (project) {
					await snapshotService.restoreSnapshot(project.path, snapshot);
					debug.log('snapshot', 'Files restored from snapshot');
					filesRestored = 1;
				}
			}
		}

		// 8. Broadcast messages-changed to users in the chat session
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
				timestamp: sessionEnd.timestamp
			},
			filesRestored
		};
	});
