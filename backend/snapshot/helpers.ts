import { snapshotQueries, messageQueries, checkpointQueries } from '../database/queries';
import { blobStore } from './blob-store';
import { debug } from '$shared/utils/logger';
import { loadMessage } from '$shared/utils/message-formatter';
import { calculateFileChangeStats } from '$shared/utils/diff-calculator';
import type { DatabaseMessage } from '$shared/types/database/schema';
import type { UnifiedMessage, UserMessage } from '$shared/types/unified';

/**
 * Snapshot domain helper functions
 */

/** Sentinel ID for the "initial state" node (before any chat messages) */
export const INITIAL_NODE_ID = '__initial__';

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
	isInitial?: boolean; // true for the "initial state" node
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
 * Check if a user message is an internal/non-genuine user message.
 *
 * Internal messages include:
 *   1. Tool-result confirmations — content contains `tool_result` blocks
 *   2. Sub-agent / Task prompts — parentToolUseId is non-null
 *   3. Post-compaction synthetic summaries — synthetic is true
 */
export function isInternalToolMessage(msg: UnifiedMessage): boolean {
	if (msg.type !== 'user') return false;
	const user = msg as UserMessage;

	if (user.parent.toolUseId != null) return true;
	if (user.synthetic) return true;

	return user.content.some(block => block.type === 'tool_result');
}

/**
 * Extract text from a UnifiedMessage.
 */
export function extractMessageText(msg: UnifiedMessage): string {
	if (msg.type === 'reasoning') return msg.text;
	if (msg.type === 'compact_boundary') return '';

	// user or assistant — both have content arrays
	for (const block of msg.content) {
		if (block.type === 'text' && block.text) return block.text;
	}
	return '';
}

/**
 * Check if a database message is a checkpoint (real user message with text)
 */
export function isCheckpointMessage(row: DatabaseMessage): boolean {
	try {
		const msg = loadMessage(row);
		if (msg.type !== 'user') return false;
		if (isInternalToolMessage(msg)) return false;
		return extractMessageText(msg).trim() !== '';
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
 * Check if a DatabaseMessage is a session continuation
 * (assistant, internal user, or compact boundary — NOT a real user message).
 */
function isSessionContinuation(row: DatabaseMessage): boolean {
	const msg = loadMessage(row);
	if (msg.type === 'assistant' || msg.type === 'reasoning' || msg.type === 'compact_boundary') return true;
	if (msg.type === 'user' && isInternalToolMessage(msg)) return true;
	return false;
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
		children.sort((a, b) => a.created_at.localeCompare(b.created_at));

		const continuation = children.find(child => isSessionContinuation(child));
		if (!continuation) return lastValidEnd;

		current = continuation;
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
	const sorted = [...allMessages].sort((a, b) => a.created_at.localeCompare(b.created_at));

	const checkpointIndex = sorted.findIndex(m => m.id === checkpointMsg.id);
	if (checkpointIndex === -1) return checkpointMsg;

	let lastValidEnd = checkpointMsg;

	for (let i = checkpointIndex + 1; i < sorted.length; i++) {
		const row = sorted[i];
		if (isSessionContinuation(row)) {
			lastValidEnd = row;
		} else {
			// Hit a real user message — stop
			break;
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
 * Get file change stats for a checkpoint.
 * The snapshot associated with the checkpoint message itself contains the stats
 * (file changes the assistant made in response to this user message).
 */
export async function getCheckpointFileStats(
	checkpointMsg: DatabaseMessage
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
	const snapshot = snapshotQueries.getByMessageId(checkpointMsg.id);
	if (!snapshot) {
		return { filesChanged: 0, insertions: 0, deletions: 0 };
	}

	let filesChanged = snapshot.files_changed || 0;
	let insertions = snapshot.insertions || 0;
	let deletions = snapshot.deletions || 0;

	// Fallback for snapshots captured before nested-repo files were tracked:
	// `session_changes` may be non-empty (with nested-repo entries) but
	// `files_changed`/`insertions`/`deletions` are 0 because the capture
	// loop never saw those files. Recompute from the blob store so the
	// Restore Checkpoint UI shows the real numbers retroactively.
	if (snapshot.session_changes && (insertions === 0 || deletions === 0)) {
		try {
			const changes = JSON.parse(snapshot.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
			const changeCount = Object.keys(changes).length;
			if (changeCount > 0) {
				const previousSnapshot: Record<string, Buffer> = {};
				const currentSnapshot: Record<string, Buffer> = {};
				let allBlobsOk = true;
				for (const [filepath, entry] of Object.entries(changes)) {
					if (entry.oldHash) {
						try { previousSnapshot[filepath] = await blobStore.readBlob(entry.oldHash); }
						catch { allBlobsOk = false; break; }
					}
					if (entry.newHash) {
						try { currentSnapshot[filepath] = await blobStore.readBlob(entry.newHash); }
						catch { allBlobsOk = false; break; }
					}
				}
				if (allBlobsOk) {
					const recomputed = calculateFileChangeStats(previousSnapshot, currentSnapshot);
					filesChanged = recomputed.filesChanged;
					insertions = recomputed.insertions;
					deletions = recomputed.deletions;
				}
			}
		} catch { /* use stored values */ }
	}

	return { filesChanged, insertions, deletions };
}
