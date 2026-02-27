/**
 * Snapshot Timeline WebSocket Handler (Rewritten)
 *
 * Builds timeline from parent_message_id tree structure.
 * No longer depends on branch_id markers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries, sessionQueries, checkpointQueries, snapshotQueries } from '../../lib/database/queries';
import { debug } from '$shared/utils/logger';
import {
	extractMessageText,
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findCheckpointForHead,
	isDescendant,
	getCheckpointFileStats
} from '../../lib/snapshot/helpers';
import type { CheckpointNode, TimelineResponse } from '../../lib/snapshot/helpers';
import type { SDKMessage } from '$shared/types/messaging';

export const timelineHandler = createRouter()
	.http('snapshot:get-timeline', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			nodes: t.Array(t.Any()),
			currentHeadId: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		const { sessionId } = data;

		debug.log('snapshot', 'TIMELINE - Building tree view');

		// 1. Get current HEAD
		const currentHead = sessionQueries.getHead(sessionId);
		debug.log('snapshot', `Current HEAD: ${currentHead || 'null'}`);

		if (!currentHead) {
			return { nodes: [], currentHeadId: null };
		}

		// 2. Get all messages
		const allMessages = messageQueries.getAllBySessionId(sessionId);
		debug.log('snapshot', `Total messages: ${allMessages.length}`);

		if (allMessages.length === 0) {
			return { nodes: [], currentHeadId: null };
		}

		// 3. Build checkpoint tree
		const { checkpoints, parentMap, childrenMap } = buildCheckpointTree(allMessages);
		debug.log('snapshot', `Checkpoints found: ${checkpoints.length}`);

		if (checkpoints.length === 0) {
			return { nodes: [], currentHeadId: null };
		}

		const checkpointIdSet = new Set(checkpoints.map(c => c.id));

		// 4. Find which checkpoint HEAD belongs to
		const activeCheckpointId = findCheckpointForHead(currentHead, allMessages, checkpointIdSet);
		debug.log('snapshot', `Active checkpoint: ${activeCheckpointId}`);

		// 5. Build active path (from root to active checkpoint)
		const activePathIds = new Set<string>();
		if (activeCheckpointId) {
			const activePath = getCheckpointPathToRoot(activeCheckpointId, parentMap);
			for (const id of activePath) {
				activePathIds.add(id);
			}
		}

		// 6. Get active children map from database
		const activeChildrenMap = checkpointQueries.getAllActiveChildren(sessionId);

		// 7. Sort checkpoints by timestamp for file stats calculation
		const sortedCheckpoints = [...checkpoints].sort(
			(a, b) => a.timestamp.localeCompare(b.timestamp)
		);

		// Build next-checkpoint timestamp map for stats
		const nextTimestampMap = new Map<string, string>();
		for (let i = 0; i < sortedCheckpoints.length; i++) {
			const next = sortedCheckpoints[i + 1];
			if (next) {
				nextTimestampMap.set(sortedCheckpoints[i].id, next.timestamp);
			}
		}

		// 8. Build response nodes
		const nodes: CheckpointNode[] = [];

		for (const cp of checkpoints) {
			const sdk = JSON.parse(cp.sdk_message) as SDKMessage;
			const messageText = extractMessageText(sdk).trim().slice(0, 100);
			const parentCpId = parentMap.get(cp.id) || null;
			const activeChildId = activeChildrenMap.get(cp.id) || null;
			const isOnActivePath = activePathIds.has(cp.id);
			const isCurrent = cp.id === activeCheckpointId;

			// Orphaned = descendant of active checkpoint in the checkpoint tree
			let isOrphaned = false;
			if (activeCheckpointId && !isOnActivePath) {
				isOrphaned = isDescendant(cp.id, activeCheckpointId, childrenMap);
			}

			// File stats
			const nextTimestamp = nextTimestampMap.get(cp.id);
			const stats = getCheckpointFileStats(cp, allMessages, nextTimestamp);

			const snapshot = snapshotQueries.getByMessageId(cp.id);

			nodes.push({
				id: cp.id,
				messageId: cp.id,
				parentId: parentCpId,
				activeChildId,
				timestamp: cp.timestamp,
				messageText,
				isOnActivePath,
				isOrphaned,
				isCurrent,
				hasSnapshot: !!snapshot,
				senderName: cp.sender_name,
				filesChanged: stats.filesChanged,
				insertions: stats.insertions,
				deletions: stats.deletions
			});
		}

		debug.log('snapshot', `Timeline nodes: ${nodes.length}`);
		debug.log('snapshot', `Active path: ${activePathIds.size} nodes`);

		return {
			nodes,
			currentHeadId: activeCheckpointId
		};
	});
