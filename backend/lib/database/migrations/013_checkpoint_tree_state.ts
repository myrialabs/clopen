/**
 * Migration: Checkpoint Tree State
 * Purpose: Track active child per checkpoint for tree display ordering.
 * This replaces the fragile branch_id-based approach with a clean
 * parent-child tracking mechanism.
 */

import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add checkpoint tree state for display ordering';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating checkpoint_tree_state table...');

	// Track which child checkpoint continues the "main line" (straight)
	// at each branch point. This is used for tree display ordering.
	db.exec(`
		CREATE TABLE IF NOT EXISTS checkpoint_tree_state (
			session_id TEXT NOT NULL,
			parent_checkpoint_id TEXT NOT NULL,
			active_child_id TEXT NOT NULL,
			PRIMARY KEY (session_id, parent_checkpoint_id)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_checkpoint_tree_session
		ON checkpoint_tree_state(session_id)
	`);

	// Initialize checkpoint_tree_state for existing sessions
	// by analyzing HEAD path relationships
	debug.log('migration', '🔗 Initializing tree state from existing sessions...');

	const sessions = db.prepare(`
		SELECT id, current_head_message_id FROM chat_sessions
		WHERE current_head_message_id IS NOT NULL
	`).all() as { id: string; current_head_message_id: string }[];

	for (const session of sessions) {
		try {
			// Walk HEAD path from head to root
			const path: string[] = [];
			let currentId: string | null = session.current_head_message_id;

			while (currentId) {
				path.unshift(currentId);
				const msg = db.prepare(`
					SELECT parent_message_id FROM messages WHERE id = ?
				`).get(currentId) as { parent_message_id: string | null } | null;
				if (!msg) break;
				currentId = msg.parent_message_id || null;
			}

			// Find checkpoint messages (user messages with text, not tool confirmations)
			const checkpointsOnPath: string[] = [];
			for (const msgId of path) {
				const msg = db.prepare(`
					SELECT sdk_message FROM messages WHERE id = ?
				`).get(msgId) as { sdk_message: string } | null;
				if (!msg) continue;

				try {
					const sdk = JSON.parse(msg.sdk_message);
					if (sdk.type !== 'user') continue;

					// Check if it's a tool confirmation (not a real user message)
					const content = sdk.message?.content;
					if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')) {
						continue;
					}

					// Check if it has text
					let hasText = false;
					if (typeof content === 'string' && content.trim()) {
						hasText = true;
					} else if (Array.isArray(content)) {
						hasText = content.some((b: any) => typeof b === 'object' && 'text' in b && b.text?.trim());
					}

					if (hasText) {
						checkpointsOnPath.push(msgId);
					}
				} catch {
					// Skip unparseable messages
				}
			}

			// Set active child for consecutive checkpoints on the path
			for (let i = 0; i < checkpointsOnPath.length - 1; i++) {
				const parentCp = checkpointsOnPath[i];
				const childCp = checkpointsOnPath[i + 1];

				db.prepare(`
					INSERT OR REPLACE INTO checkpoint_tree_state
					(session_id, parent_checkpoint_id, active_child_id)
					VALUES (?, ?, ?)
				`).run(session.id, parentCp, childCp);
			}

			if (checkpointsOnPath.length > 1) {
				debug.log('migration', `  ✓ Session ${session.id}: ${checkpointsOnPath.length - 1} active child links`);
			}
		} catch (err) {
			debug.warn('migration', `  ⚠ Could not process session ${session.id}: ${err}`);
		}
	}

	debug.log('migration', '✅ Checkpoint tree state created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing checkpoint tree state...');
	db.exec('DROP INDEX IF EXISTS idx_checkpoint_tree_session');
	db.exec('DROP TABLE IF EXISTS checkpoint_tree_state');
	debug.log('migration', '✅ Checkpoint tree state removed');
};
