/**
 * Checkpoint Tree State Queries
 *
 * Manages the "active child" tracking per checkpoint node.
 * This determines which child continues the straight/main line
 * in the tree display, and which children are branches.
 */

import { getDatabase } from '../index';
import { debug } from '$shared/utils/logger';

export const checkpointQueries = {
	/**
	 * Get active child for a checkpoint
	 */
	getActiveChild(sessionId: string, parentCheckpointId: string): string | null {
		const db = getDatabase();
		const row = db.prepare(`
			SELECT active_child_id FROM checkpoint_tree_state
			WHERE session_id = ? AND parent_checkpoint_id = ?
		`).get(sessionId, parentCheckpointId) as { active_child_id: string } | null;

		return row?.active_child_id || null;
	},

	/**
	 * Set active child for a checkpoint
	 */
	setActiveChild(sessionId: string, parentCheckpointId: string, activeChildId: string): void {
		const db = getDatabase();
		db.prepare(`
			INSERT OR REPLACE INTO checkpoint_tree_state
			(session_id, parent_checkpoint_id, active_child_id)
			VALUES (?, ?, ?)
		`).run(sessionId, parentCheckpointId, activeChildId);
	},

	/**
	 * Get all active children for a session (for building the tree)
	 */
	getAllActiveChildren(sessionId: string): Map<string, string> {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT parent_checkpoint_id, active_child_id FROM checkpoint_tree_state
			WHERE session_id = ?
		`).all(sessionId) as { parent_checkpoint_id: string; active_child_id: string }[];

		const map = new Map<string, string>();
		for (const row of rows) {
			map.set(row.parent_checkpoint_id, row.active_child_id);
		}
		return map;
	},

	/**
	 * Update active children along a path from root to target checkpoint.
	 * This is called when restoring to a checkpoint or creating a new one.
	 *
	 * @param sessionId - The chat session ID
	 * @param checkpointPath - Ordered list of checkpoint IDs from root to target
	 */
	updateActiveChildrenAlongPath(sessionId: string, checkpointPath: string[]): void {
		const db = getDatabase();

		const stmt = db.prepare(`
			INSERT OR REPLACE INTO checkpoint_tree_state
			(session_id, parent_checkpoint_id, active_child_id)
			VALUES (?, ?, ?)
		`);

		for (let i = 0; i < checkpointPath.length - 1; i++) {
			stmt.run(sessionId, checkpointPath[i], checkpointPath[i + 1]);
		}

		debug.log('snapshot', `Updated ${checkpointPath.length - 1} active child links for session ${sessionId}`);
	},

	/**
	 * Delete all tree state for a session (cleanup)
	 */
	deleteForSession(sessionId: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM checkpoint_tree_state WHERE session_id = ?
		`).run(sessionId);
	}
};
