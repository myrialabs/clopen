import { getDatabase } from '../index';
import type { DatabaseMessage } from '$shared/types/database/schema';
import type { UnifiedMessage } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';

/** Parse message JSON from a DB row. */
function parseMessage(row: DatabaseMessage): UnifiedMessage {
	return JSON.parse(row.data) as UnifiedMessage;
}

export const messageQueries = {
	/**
	 * Get visible messages for a session (git-like: from HEAD to root)
	 * This is the main function used to display messages in UI.
	 */
	getBySessionId(sessionId: string): UnifiedMessage[] {
		const db = getDatabase();

		const session = db.prepare(`
			SELECT head_message_id FROM chat_sessions WHERE id = ?
		`).get(sessionId) as { head_message_id: string | null } | null;

		if (!session || !session.head_message_id) {
			return [];
		}

		const path = this.getPathToRoot(session.head_message_id);
		return path.map(parseMessage);
	},

	/**
	 * Get all messages for a session including deleted ones (for timeline view)
	 */
	getAllBySessionId(sessionId: string): DatabaseMessage[] {
		const db = getDatabase();
		const messages = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ?
			ORDER BY created_at ASC
		`).all(sessionId) as DatabaseMessage[];

		return messages;
	},

	getById(id: string): DatabaseMessage | null {
		const db = getDatabase();
		const message = db.prepare(`
			SELECT * FROM messages WHERE id = ?
		`).get(id) as DatabaseMessage | null;

		return message;
	},

	create(messageData: {
		session_id: string;
		message: UnifiedMessage;
		timestamp?: string;
		branch_id?: string;
		parent_message_id?: string;
	}): DatabaseMessage {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const timestamp = messageData.timestamp || new Date().toISOString();
		const parentMessageId = messageData.parent_message_id || null;

		// Sync metadata into JSON blob so it is the single source of truth
		const msg: UnifiedMessage = {
			...messageData.message,
			messageId: id,
			createdAt: timestamp,
			sessionId: messageData.message.sessionId,
			parent: {
				...messageData.message.parent,
				messageId: parentMessageId,
			},
		};

		const serialized = JSON.stringify(msg);

		db.prepare(`
			INSERT INTO messages (id, session_id, created_at, data, is_deleted, branch_id, parent_message_id)
			VALUES (?, ?, ?, ?, 0, ?, ?)
		`).run(
			id,
			messageData.session_id,
			timestamp,
			serialized,
			messageData.branch_id || null,
			parentMessageId
		);

		return {
			id,
			session_id: messageData.session_id,
			created_at: timestamp,
			data: serialized,
			is_deleted: 0,
			branch_id: messageData.branch_id || null,
			parent_message_id: parentMessageId
		};
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM messages WHERE id = ?').run(id);
	},

	deleteBySessionId(sessionId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
	},

	deleteAfterTimestamp(sessionId: string, timestamp: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM messages
			WHERE session_id = ? AND created_at >= ?
		`).run(sessionId, timestamp);
	},

	/**
	 * Soft delete messages after a specific checkpoint message (for undo with branch support)
	 * Preserves checkpoint conversation (user + assistant responses) and deletes from next user message onward
	 */
	softDeleteAfterTimestamp(sessionId: string, checkpointTimestamp: string, branchId: string): void {
		const db = getDatabase();

		const allMessages = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ?
			ORDER BY created_at ASC
		`).all(sessionId) as DatabaseMessage[];

		const checkpointIndex = allMessages.findIndex(msg => msg.created_at === checkpointTimestamp);

		if (checkpointIndex === -1) {
			debug.warn('database', `Checkpoint message with timestamp ${checkpointTimestamp} not found`);
			return;
		}

		// Find next USER message after checkpoint (this is where we start deleting)
		let deleteFromIndex = -1;
		for (let i = checkpointIndex + 1; i < allMessages.length; i++) {
			const msg = parseMessage(allMessages[i]);
			if (msg.type === 'user') {
				deleteFromIndex = i;
				break;
			}
		}

		// If no user message found after checkpoint, nothing to delete
		if (deleteFromIndex === -1) {
			debug.log('database', 'No user messages to soft delete after checkpoint');
			return;
		}

		// Get IDs of messages from next user message onward
		const messagesToDelete = allMessages
			.slice(deleteFromIndex)
			.map(msg => msg.id);

		if (messagesToDelete.length === 0) {
			debug.log('database', 'No messages to soft delete after checkpoint');
			return;
		}

		// Soft delete messages
		const placeholders = messagesToDelete.map(() => '?').join(',');
		db.prepare(`
			UPDATE messages
			SET is_deleted = 1, branch_id = ?
			WHERE id IN (${placeholders}) AND (is_deleted IS NULL OR is_deleted = 0)
		`).run(branchId, ...messagesToDelete);

		debug.log('database', `Soft deleted ${messagesToDelete.length} messages from next user message after checkpoint`);
	},

	/**
	 * Restore messages from a specific branch (for redo)
	 */
	restoreBranch(sessionId: string, branchId: string): void {
		const db = getDatabase();
		// Mark current active messages as deleted (switch to another branch)
		db.prepare(`
			UPDATE messages
			SET is_deleted = 1
			WHERE session_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
		`).run(sessionId);

		// Restore messages from target branch
		db.prepare(`
			UPDATE messages
			SET is_deleted = 0
			WHERE session_id = ? AND branch_id = ?
		`).run(sessionId, branchId);

		// Also restore messages that are on main branch (no branch_id) up to the branching point
		// We need to restore all messages before the first message in the target branch
		const firstBranchMessage = db.prepare(`
			SELECT MIN(created_at) as min_created_at
			FROM messages
			WHERE session_id = ? AND branch_id = ?
		`).get(sessionId, branchId) as { min_created_at: string } | undefined;

		if (firstBranchMessage?.min_created_at) {
			db.prepare(`
				UPDATE messages
				SET is_deleted = 0
				WHERE session_id = ? AND (branch_id IS NULL OR branch_id = '') AND created_at < ?
			`).run(sessionId, firstBranchMessage.min_created_at);
		}
	},

	/**
	 * Get messages by branch ID
	 */
	getByBranchId(sessionId: string, branchId: string): DatabaseMessage[] {
		const db = getDatabase();
		const messages = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ? AND branch_id = ?
			ORDER BY created_at ASC
		`).all(sessionId, branchId) as DatabaseMessage[];

		return messages;
	},

	/**
	 * Get all branches for a session
	 */
	getBranches(sessionId: string): string[] {
		const db = getDatabase();
		const branches = db.prepare(`
			SELECT DISTINCT branch_id
			FROM messages
			WHERE session_id = ? AND branch_id IS NOT NULL AND branch_id != ''
			ORDER BY branch_id ASC
		`).all(sessionId) as { branch_id: string }[];

		return branches.map(b => b.branch_id);
	},

	/**
	 * Get the last message before a specific timestamp in a session
	 * Used to find the SDK session ID to resume from after restore
	 */
	getLastBeforeTimestamp(sessionId: string, timestamp: string): DatabaseMessage | null {
		const db = getDatabase();
		const message = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ? AND created_at < ? AND (is_deleted IS NULL OR is_deleted = 0)
			ORDER BY created_at DESC
			LIMIT 1
		`).get(sessionId, timestamp) as DatabaseMessage | null;

		return message;
	},

	/**
	 * Get the first assistant message after a specific timestamp in a session
	 * Used to find the SDK session ID from the response to the checkpoint message
	 */
	getFirstAssistantAfterTimestamp(sessionId: string, timestamp: string): DatabaseMessage | null {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ? AND created_at > ? AND (is_deleted IS NULL OR is_deleted = 0)
			ORDER BY created_at ASC
		`).all(sessionId, timestamp) as DatabaseMessage[];

		for (const row of rows) {
			const msg = parseMessage(row);
			if (msg.type === 'assistant') {
				return row;
			}
		}

		return null;
	},

	// ==================== GIT-LIKE GRAPH OPERATIONS ====================

	/**
	 * Get children of a message (messages that have this message as parent)
	 */
	getChildren(messageId: string): DatabaseMessage[] {
		const db = getDatabase();
		const messages = db.prepare(`
			SELECT * FROM messages
			WHERE parent_message_id = ?
			ORDER BY created_at ASC
		`).all(messageId) as DatabaseMessage[];

		return messages;
	},

	/**
	 * Get all messages in the path from a message to the root (first message)
	 * Used to build the main branch path
	 */
	getPathToRoot(messageId: string): DatabaseMessage[] {
		const db = getDatabase();
		const path: DatabaseMessage[] = [];
		let currentId: string | null = messageId;

		while (currentId) {
			const message = db.prepare(`
				SELECT * FROM messages WHERE id = ?
			`).get(currentId) as DatabaseMessage | null;

			if (!message) break;

			path.unshift(message); // Add to beginning
			currentId = message.parent_message_id || null;
		}

		return path;
	},

	/**
	 * Get all descendants of a message (entire subtree)
	 */
	getDescendants(messageId: string): DatabaseMessage[] {
		const db = getDatabase();
		const descendants: DatabaseMessage[] = [];
		const queue: string[] = [messageId];

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const children = this.getChildren(currentId);

			for (const child of children) {
				descendants.push(child);
				queue.push(child.id);
			}
		}

		return descendants;
	},

	/**
	 * Mark messages with a branch_id
	 * Used when creating a new branch after undo
	 */
	setBranchForMessages(messageIds: string[], branchId: string): void {
		const db = getDatabase();
		if (messageIds.length === 0) return;

		const placeholders = messageIds.map(() => '?').join(',');
		db.prepare(`
			UPDATE messages
			SET branch_id = ?
			WHERE id IN (${placeholders})
		`).run(branchId, ...messageIds);
	},

	/**
	 * Clear branch_id for messages (make them part of main branch)
	 */
	clearBranchForMessages(messageIds: string[]): void {
		const db = getDatabase();
		if (messageIds.length === 0) return;

		const placeholders = messageIds.map(() => '?').join(',');
		db.prepare(`
			UPDATE messages
			SET branch_id = NULL
			WHERE id IN (${placeholders})
		`).run(...messageIds);
	},

	/**
	 * Get all messages in a session as a graph structure
	 * Returns map of messageId -> message for easy traversal
	 */
	getMessageGraph(sessionId: string): Map<string, DatabaseMessage> {
		const db = getDatabase();
		const messages = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ?
			ORDER BY created_at ASC
		`).all(sessionId) as DatabaseMessage[];

		const graph = new Map<string, DatabaseMessage>();
		for (const message of messages) {
			graph.set(message.id, message);
		}

		return graph;
	},

	/**
	 * Find branch root for a message (first ancestor NOT in HEAD path)
	 * This is used to group orphaned messages into proper branches
	 *
	 * Example:
	 * HEAD path: A → B → C → C1
	 * Message F with path: A → B → C → C2 → D → E → F
	 * Result: C2 (first message NOT in HEAD path, diverges from C)
	 */
	findBranchRoot(messageId: string, headPathIds: Set<string>): DatabaseMessage | null {
		const db = getDatabase();
		let currentId: string | null = messageId;
		let candidateRoot: DatabaseMessage | null = null;

		// Walk up the parent chain
		while (currentId) {
			const message = db.prepare(`
				SELECT * FROM messages WHERE id = ?
			`).get(currentId) as DatabaseMessage | null;

			if (!message) break;

			// If message is IN HEAD path, we've gone too far
			// Return the last candidate (first message NOT in HEAD path)
			if (headPathIds.has(message.id)) {
				return candidateRoot;
			}

			// This message is NOT in HEAD path, it's a candidate root
			candidateRoot = message;
			currentId = message.parent_message_id || null;
		}

		// If we reached the root without finding HEAD path, return the candidate
		// This happens when the entire path is orphaned (shouldn't happen normally)
		return candidateRoot;
	},

	/**
	 * Mark messages with unanswered tool_use blocks as interrupted.
	 * Called when stream ends (complete/error/cancel) to persist the interrupted state.
	 */
	markInterruptedMessages(sessionId: string): void {
		const db = getDatabase();

		const rows = db.prepare(`
			SELECT * FROM messages
			WHERE session_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
			ORDER BY created_at ASC
		`).all(sessionId) as DatabaseMessage[];

		// Collect all tool_use_ids that have a matching tool_result
		const answeredToolIds = new Set<string>();
		for (const row of rows) {
			const msg = parseMessage(row);
			if (msg.type !== 'user') continue;
			for (const block of msg.content) {
				if (block.type === 'tool_result' && block.toolUseId) {
					answeredToolIds.add(block.toolUseId);
				}
			}
		}

		// Find assistant messages with unanswered tool_use blocks and mark them
		const updateStmt = db.prepare(`UPDATE messages SET data = ? WHERE id = ?`);

		for (const row of rows) {
			const msg = parseMessage(row);
			if (msg.type !== 'assistant') continue;

			const hasUnansweredTool = msg.content.some(
				block => block.type === 'tool_use' && block.id && !answeredToolIds.has(block.id)
			);

			if (!hasUnansweredTool || msg.stopReason === 'interrupted') continue;

			// Write back as UnifiedMessage with interrupted stopReason
			const updated = { ...msg, stopReason: 'interrupted' as const };
			updateStmt.run(JSON.stringify(updated), row.id);
		}
	},

	/**
	 * Group orphaned messages by their branch root
	 * Returns map of branchRootId -> [orphaned messages]
	 *
	 * This ensures that multi-level trees are preserved:
	 * - If C2 is orphaned and D, E, F are children of C2
	 * - All of them will be grouped under C2's branch
	 */
	groupOrphanedByBranchRoot(
		orphanedMessages: DatabaseMessage[],
		headPathIds: Set<string>
	): Map<string, DatabaseMessage[]> {
		const groups = new Map<string, DatabaseMessage[]>();

		for (const msg of orphanedMessages) {
			// Find the branch root for this message
			const branchRoot = this.findBranchRoot(msg.id, headPathIds);

			if (!branchRoot) {
				debug.warn('database', `No branch root found for orphaned message ${msg.id}`);
				continue;
			}

			// Group messages by their branch root
			if (!groups.has(branchRoot.id)) {
				groups.set(branchRoot.id, []);
			}
			groups.get(branchRoot.id)!.push(msg);
		}

		return groups;
	}
};
