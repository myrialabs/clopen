import { snapshotQueries, messageQueries, checkpointQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';
import type { SDKMessage } from '$shared/types/messaging';
import type { DatabaseMessage } from '$shared/types/database/schema';

/**
 * Snapshot domain helper functions
 */

export interface CheckpointNode {
	id: string;
	messageId: string;
	parentId: string | null; // parent checkpoint ID in the tree
	activeChildId: string | null; // which child continues straight
	timestamp: string;
	messageText: string;
	isOnActivePath: boolean;
	isOrphaned: boolean; // descendant of current active checkpoint
	isCurrent: boolean; // this is the current active checkpoint
	hasSnapshot: boolean;
	senderName?: string | null;
	// File change statistics (git-like)
	filesChanged?: number;
	insertions?: number;
	deletions?: number;
}

export interface TimelineResponse {
	nodes: CheckpointNode[];
	currentHeadId: string | null;
}

/**
 * Check if a user message is an internal tool confirmation message
 * Internal messages contain tool_result blocks, not regular text input
 */
export function isInternalToolMessage(sdkMessage: any): boolean {
	if (sdkMessage.type !== 'user') return false;

	const content = sdkMessage.message?.content;
	if (!content) return false;

	// Check if content is array and contains tool_result blocks
	if (Array.isArray(content)) {
		return content.some((block: any) => block.type === 'tool_result');
	}

	return false;
}

/**
 * Extract user message text from SDK message
 */
export function extractMessageText(sdkMessage: SDKMessage): string {
	if ('message' in sdkMessage && sdkMessage.message?.content) {
		const content = sdkMessage.message.content;
		if (typeof content === 'string') {
			return content;
		} else if (Array.isArray(content)) {
			const textBlock = content.find(
				(item: any) => typeof item === 'object' && 'text' in item
			);
			if (textBlock && 'text' in textBlock) {
				return textBlock.text;
			}
		}
	}
	return '';
}

/**
 * Check if a database message is a checkpoint (real user message with text)
 */
export function isCheckpointMessage(msg: DatabaseMessage): boolean {
	try {
		const sdk = JSON.parse(msg.sdk_message) as SDKMessage;
		if (sdk.type !== 'user') return false;
		if (isInternalToolMessage(sdk)) return false;
		const text = extractMessageText(sdk);
		return text.trim() !== '';
	} catch {
		return false;
	}
}

/**
 * Build checkpoint tree from all messages in a session.
 * Returns a map of checkpoint IDs to their parent checkpoint IDs.
 *
 * A "checkpoint" is a real user message (not tool confirmation) with text.
 * The parent-child relationship is determined by the message parent chain.
 */
export function buildCheckpointTree(
	allMessages: DatabaseMessage[]
): {
	checkpoints: DatabaseMessage[];
	parentMap: Map<string, string>; // childId -> parentId
	childrenMap: Map<string, string[]>; // parentId -> [childIds]
} {
	const msgMap = new Map<string, DatabaseMessage>();
	for (const msg of allMessages) {
		msgMap.set(msg.id, msg);
	}

	// Identify all checkpoint messages
	const checkpoints: DatabaseMessage[] = [];
	const checkpointIdSet = new Set<string>();

	for (const msg of allMessages) {
		if (isCheckpointMessage(msg)) {
			checkpoints.push(msg);
			checkpointIdSet.add(msg.id);
		}
	}

	// For each checkpoint, find its parent checkpoint
	// by walking back through the message parent chain
	const parentMap = new Map<string, string>(); // childCheckpoint -> parentCheckpoint
	const childrenMap = new Map<string, string[]>();

	for (const cp of checkpoints) {
		let currentId = cp.parent_message_id;
		while (currentId) {
			if (checkpointIdSet.has(currentId)) {
				parentMap.set(cp.id, currentId);
				if (!childrenMap.has(currentId)) {
					childrenMap.set(currentId, []);
				}
				childrenMap.get(currentId)!.push(cp.id);
				break;
			}
			const parentMsg = msgMap.get(currentId);
			if (!parentMsg) break;
			currentId = parentMsg.parent_message_id || null;
		}
	}

	return { checkpoints, parentMap, childrenMap };
}

/**
 * Find the checkpoint path from root to a given checkpoint.
 * Returns ordered list of checkpoint IDs from root to target.
 */
export function getCheckpointPathToRoot(
	checkpointId: string,
	parentMap: Map<string, string>
): string[] {
	const path: string[] = [];
	let currentId: string | null = checkpointId;

	while (currentId) {
		path.unshift(currentId);
		currentId = parentMap.get(currentId) || null;
	}

	return path;
}

/**
 * Find which checkpoint the current HEAD belongs to.
 * Walks back from HEAD through message parents until finding a checkpoint.
 */
export function findCheckpointForHead(
	headMessageId: string,
	allMessages: DatabaseMessage[],
	checkpointIdSet: Set<string>
): string | null {
	const msgMap = new Map<string, DatabaseMessage>();
	for (const msg of allMessages) {
		msgMap.set(msg.id, msg);
	}

	let currentId: string | null = headMessageId;
	while (currentId) {
		if (checkpointIdSet.has(currentId)) {
			return currentId;
		}
		const msg = msgMap.get(currentId);
		if (!msg) break;
		currentId = msg.parent_message_id || null;
	}

	return null;
}

/**
 * Find the session end for a checkpoint.
 * This is the last message of the checkpoint's session
 * (last assistant/tool response before the next real user message).
 *
 * Uses two approaches:
 * 1. Parent-based: Walk forward through children from checkpoint
 * 2. Timestamp-based fallback: If parent-based fails, use chronological order
 */
export function findSessionEnd(
	checkpointMsg: DatabaseMessage,
	allMessages: DatabaseMessage[]
): DatabaseMessage {
	// Try parent-based approach first
	const parentResult = findSessionEndByParent(checkpointMsg, allMessages);

	// If parent-based approach found a session end beyond the checkpoint, use it
	if (parentResult.id !== checkpointMsg.id) {
		debug.log('snapshot', `findSessionEnd: parent-based → ${parentResult.id.slice(0, 8)}`);
		return parentResult;
	}

	// Fallback: timestamp-based approach
	// Walk chronologically through messages after checkpoint until next real user message
	debug.log('snapshot', `findSessionEnd: parent-based returned checkpoint itself, trying timestamp fallback`);
	const timestampResult = findSessionEndByTimestamp(checkpointMsg, allMessages);

	if (timestampResult.id !== checkpointMsg.id) {
		debug.log('snapshot', `findSessionEnd: timestamp-based → ${timestampResult.id.slice(0, 8)}`);
		return timestampResult;
	}

	debug.log('snapshot', `findSessionEnd: no session continuation found, returning checkpoint ${checkpointMsg.id.slice(0, 8)}`);
	return checkpointMsg;
}

/**
 * Parent-based session end finder.
 * Walks through childrenMap (parent_message_id relationships).
 */
function findSessionEndByParent(
	checkpointMsg: DatabaseMessage,
	allMessages: DatabaseMessage[]
): DatabaseMessage {
	const childrenMap = new Map<string, DatabaseMessage[]>();
	for (const msg of allMessages) {
		if (msg.parent_message_id) {
			if (!childrenMap.has(msg.parent_message_id)) {
				childrenMap.set(msg.parent_message_id, []);
			}
			childrenMap.get(msg.parent_message_id)!.push(msg);
		}
	}

	let current = checkpointMsg;
	let lastValidEnd = checkpointMsg;

	while (true) {
		const children = childrenMap.get(current.id) || [];
		children.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		let sessionContinuation: DatabaseMessage | null = null;

		for (const child of children) {
			try {
				const sdk = JSON.parse(child.sdk_message);
				if (sdk.type === 'assistant') {
					sessionContinuation = child;
					break;
				}
				if (sdk.type === 'user' && isInternalToolMessage(sdk)) {
					sessionContinuation = child;
					break;
				}
			} catch {
				continue;
			}
		}

		if (!sessionContinuation) {
			return lastValidEnd;
		}

		current = sessionContinuation;
		lastValidEnd = current;
	}
}

/**
 * Timestamp-based session end finder (fallback).
 * Walks chronologically through messages after checkpoint
 * until hitting the next real user message (checkpoint).
 */
function findSessionEndByTimestamp(
	checkpointMsg: DatabaseMessage,
	allMessages: DatabaseMessage[]
): DatabaseMessage {
	const sorted = [...allMessages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	const checkpointIndex = sorted.findIndex(m => m.id === checkpointMsg.id);
	if (checkpointIndex === -1) return checkpointMsg;

	let lastValidEnd = checkpointMsg;

	for (let i = checkpointIndex + 1; i < sorted.length; i++) {
		const msg = sorted[i];
		try {
			const sdk = JSON.parse(msg.sdk_message);

			if (sdk.type === 'assistant') {
				lastValidEnd = msg;
			} else if (sdk.type === 'user' && isInternalToolMessage(sdk)) {
				lastValidEnd = msg;
			} else if (sdk.type === 'user' && !isInternalToolMessage(sdk)) {
				// Hit the next real user message (checkpoint) - stop
				break;
			}
		} catch {
			continue;
		}
	}

	return lastValidEnd;
}

/**
 * Check if checkpointId is a descendant of ancestorId in the checkpoint tree
 */
export function isDescendant(
	checkpointId: string,
	ancestorId: string,
	childrenMap: Map<string, string[]>
): boolean {
	// IMPORTANT: Copy the array to avoid mutating the original childrenMap
	const queue = [...(childrenMap.get(ancestorId) || [])];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current === checkpointId) return true;
		if (visited.has(current)) continue;
		visited.add(current);

		const children = childrenMap.get(current) || [];
		queue.push(...children);
	}

	return false;
}

/**
 * Get file change stats for a checkpoint by looking at snapshots
 * between this checkpoint and the next.
 */
export function getCheckpointFileStats(
	checkpointMsg: DatabaseMessage,
	allMessages: DatabaseMessage[],
	nextCheckpointTimestamp?: string
): { filesChanged: number; insertions: number; deletions: number } {
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	const checkpointTimestamp = checkpointMsg.timestamp;

	const laterMessages = allMessages
		.filter(m => {
			if (m.timestamp <= checkpointTimestamp) return false;
			if (nextCheckpointTimestamp && m.timestamp >= nextCheckpointTimestamp) return false;
			return true;
		})
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	const allChangedFiles = new Set<string>();
	const statsInRange: Array<{ files: number; ins: number; del: number }> = [];

	for (const msg of laterMessages) {
		try {
			const sdkMsg = JSON.parse(msg.sdk_message) as SDKMessage;
			if (sdkMsg.type !== 'user') continue;

			const userSnapshot = snapshotQueries.getByMessageId(msg.id);
			if (!userSnapshot) continue;

			const fc = userSnapshot.files_changed || 0;
			const ins = userSnapshot.insertions || 0;
			const del = userSnapshot.deletions || 0;

			if (fc > 0 || ins > 0 || del > 0) {
				statsInRange.push({ files: fc, ins, del });
			}

			if (userSnapshot.delta_changes) {
				try {
					const delta = JSON.parse(userSnapshot.delta_changes);
					if (delta.added) Object.keys(delta.added).forEach(f => allChangedFiles.add(f));
					if (delta.modified) Object.keys(delta.modified).forEach(f => allChangedFiles.add(f));
					if (delta.deleted && Array.isArray(delta.deleted)) delta.deleted.forEach((f: string) => allChangedFiles.add(f));
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}

	if (statsInRange.length > 0) {
		filesChanged = allChangedFiles.size > 0 ? allChangedFiles.size : Math.max(...statsInRange.map(s => s.files));
		insertions = statsInRange.reduce((sum, s) => sum + s.ins, 0);
		deletions = statsInRange.reduce((sum, s) => sum + s.del, 0);
	}

	return { filesChanged, insertions, deletions };
}
