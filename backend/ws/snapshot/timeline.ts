/**
 * Snapshot Timeline WebSocket Handler (Rewritten)
 *
 * Builds timeline from parent_message_id tree structure.
 * No longer depends on branch_id markers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries, sessionQueries, checkpointQueries, snapshotQueries } from '../../database/queries';
import { debug } from '$shared/utils/logger';
import { loadMessage } from '$shared/utils/message-formatter';
import {
	extractMessageText,
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findCheckpointForHead,
	isDescendant,
	getCheckpointFileStats,
	INITIAL_NODE_ID
} from '../../snapshot/helpers';
import type { CheckpointNode, TimelineResponse } from '../../snapshot/helpers';
import { requireSessionAccess } from '../access';

export const timelineHandler = createRouter()
	.http('snapshot:get-timeline', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			nodes: t.Array(t.Any()),
			currentHeadId: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		const { sessionId } = data;
		requireSessionAccess(conn, sessionId);

		debug.log('snapshot', 'TIMELINE - Building tree view');

		// 1. Get current HEAD
		const currentHead = sessionQueries.getHead(sessionId);
		const isAtInitialState = !currentHead;
		debug.log('snapshot', `Current HEAD: ${currentHead || 'null (initial state)'}`);

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
		const activeCheckpointId = isAtInitialState
			? null
			: findCheckpointForHead(currentHead, allMessages, checkpointIdSet);
		debug.log('snapshot', `Active checkpoint: ${activeCheckpointId || '(initial)'}`);

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

		// 7. Build response nodes
		const nodes: CheckpointNode[] = [];

		// Find root checkpoints (those with no parent)
		const rootCheckpointIds = checkpoints
			.filter(cp => !parentMap.has(cp.id))
			.map(cp => cp.id);

		// Get session started_at for the initial node timestamp
		const session = sessionQueries.getById(sessionId);
		const sessionStartedAt = session?.started_at || new Date().toISOString();

		// Add the "Initial State" node at the beginning
		// Its activeChildId points to the first root checkpoint on the active path,
		// or the first root checkpoint if we're at initial state
		let initialActiveChildId: string | null = null;
		if (isAtInitialState) {
			// At initial state: the first root checkpoint (by timestamp) is the active child
			initialActiveChildId = rootCheckpointIds[0] || null;
		} else {
			// Find root checkpoint on active path
			initialActiveChildId = rootCheckpointIds.find(id => activePathIds.has(id)) || rootCheckpointIds[0] || null;
		}

		nodes.push({
			id: INITIAL_NODE_ID,
			messageId: INITIAL_NODE_ID,
			parentId: null,
			activeChildId: initialActiveChildId,
			timestamp: sessionStartedAt,
			messageText: 'Session Start',
			isOnActivePath: isAtInitialState || activePathIds.size > 0,
			isOrphaned: false,
			isCurrent: isAtInitialState,
			hasSnapshot: false,
			isInitial: true,
			senderName: null,
			filesChanged: 0,
			insertions: 0,
			deletions: 0
		});

		for (const cp of checkpoints) {
			const msg = loadMessage(cp);
			const messageText = extractMessageText(msg).trim().slice(0, 100);
			const parentCpId = parentMap.get(cp.id) || null;
			const activeChildId = activeChildrenMap.get(cp.id) || null;
			const isOnActivePath = activePathIds.has(cp.id);
			const isCurrent = cp.id === activeCheckpointId;

			// Orphaned = in the "future" relative to the current checkpoint.
			// At initial state: ALL checkpoints are orphaned (we've gone back before any messages).
			// Otherwise: only descendants of the active checkpoint that are not on the active path.
			let isOrphaned = false;
			if (isAtInitialState) {
				isOrphaned = true;
			} else if (activeCheckpointId && !isOnActivePath) {
				isOrphaned = isDescendant(cp.id, activeCheckpointId, childrenMap);
			}

			// File stats from checkpoint's own snapshot
			const stats = await getCheckpointFileStats(cp);

			const snapshot = snapshotQueries.getByMessageId(cp.id);

			nodes.push({
				id: cp.id,
				messageId: cp.id,
				// Root checkpoints have initial node as parent
				parentId: parentCpId || INITIAL_NODE_ID,
				activeChildId,
				timestamp: cp.created_at,
				messageText,
				isOnActivePath,
				isOrphaned,
				isCurrent,
				hasSnapshot: !!snapshot,
				senderName: msg.type === 'user' ? msg.sender?.name || null : null,
				filesChanged: stats.filesChanged,
				insertions: stats.insertions,
				deletions: stats.deletions
			});
		}

		const currentHeadId = isAtInitialState ? INITIAL_NODE_ID : activeCheckpointId;

		debug.log('snapshot', `Timeline nodes: ${nodes.length} (including initial)`);
		debug.log('snapshot', `Active path: ${activePathIds.size} nodes, current: ${currentHeadId}`);

		return {
			nodes,
			currentHeadId
		};
	});
