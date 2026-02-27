/**
 * Database queries for message snapshots and session relationships
 * Used for time travel feature
 */

import type { MessageSnapshot, SessionRelationship } from '$shared/types/database/schema';
import { getDatabase } from '../index';

import { debug } from '$shared/utils/logger';
export const snapshotQueries = {
	/**
	 * Create a new message snapshot
	 * Supports both full and delta snapshots
	 */
	createSnapshot(data: {
		id?: string; // Optional: allow caller to provide ID (for blob store tree naming)
		message_id: string;
		session_id: string;
		project_id: string;
		files_snapshot: Record<string, string> | {}; // Will be JSON.stringified
		project_metadata?: any;
		snapshot_type?: 'full' | 'delta';
		parent_snapshot_id?: string;
		delta_changes?: any; // DeltaChanges object
		files_changed?: number;
		insertions?: number;
		deletions?: number;
		branch_id?: string;
		tree_hash?: string; // Blob store tree hash (new format)
	}): MessageSnapshot {
		const db = getDatabase();
		const id = data.id || `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const now = new Date().toISOString();

		const snapshot: MessageSnapshot = {
			id,
			message_id: data.message_id,
			session_id: data.session_id,
			project_id: data.project_id,
			files_snapshot: JSON.stringify(data.files_snapshot),
			project_metadata: data.project_metadata ? JSON.stringify(data.project_metadata) : undefined,
			created_at: now,
			snapshot_type: data.snapshot_type || 'full',
			parent_snapshot_id: data.parent_snapshot_id,
			delta_changes: data.delta_changes ? JSON.stringify(data.delta_changes) : undefined,
			files_changed: data.files_changed || 0,
			insertions: data.insertions || 0,
			deletions: data.deletions || 0,
			is_deleted: 0,
			branch_id: data.branch_id || null,
			tree_hash: data.tree_hash || null
		};

		db.prepare(`
			INSERT INTO message_snapshots (
				id, message_id, session_id, project_id,
				files_snapshot, project_metadata, created_at,
				snapshot_type, parent_snapshot_id, delta_changes,
				files_changed, insertions, deletions,
				is_deleted, branch_id, tree_hash
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
		`).run(
			snapshot.id,
			snapshot.message_id,
			snapshot.session_id,
			snapshot.project_id,
			snapshot.files_snapshot,
			snapshot.project_metadata || null,
			snapshot.created_at,
			snapshot.snapshot_type,
			snapshot.parent_snapshot_id || null,
			snapshot.delta_changes || null,
			snapshot.files_changed,
			snapshot.insertions,
			snapshot.deletions,
			snapshot.branch_id || null,
			snapshot.tree_hash || null
		);

		return snapshot;
	},

	/**
	 * Get snapshot by ID
	 */
	getById(snapshotId: string): MessageSnapshot | null {
		const db = getDatabase();
		const snapshot = db.prepare(`
			SELECT * FROM message_snapshots WHERE id = ?
		`).get(snapshotId) as MessageSnapshot | null;

		return snapshot;
	},

	/**
	 * Get snapshot by message ID
	 */
	getByMessageId(messageId: string): MessageSnapshot | null {
		const db = getDatabase();
		const snapshot = db.prepare(`
			SELECT * FROM message_snapshots WHERE message_id = ?
		`).get(messageId) as MessageSnapshot | null;

		return snapshot;
	},

	/**
	 * Get all snapshots for a session
	 */
	getBySessionId(sessionId: string): MessageSnapshot[] {
		const db = getDatabase();
		const snapshots = db.prepare(`
			SELECT * FROM message_snapshots
			WHERE session_id = ?
			ORDER BY created_at ASC
		`).all(sessionId) as MessageSnapshot[];

		return snapshots;
	},

	/**
	 * Get latest snapshot for a project
	 */
	getLatestByProjectId(projectId: string): MessageSnapshot | null {
		const db = getDatabase();
		const snapshot = db.prepare(`
			SELECT * FROM message_snapshots
			WHERE project_id = ?
			ORDER BY created_at DESC
			LIMIT 1
		`).get(projectId) as MessageSnapshot | null;

		return snapshot;
	},

	/**
	 * Delete snapshots after a certain message in a session
	 * Used when restoring to a previous state (hard delete - deprecated)
	 */
	deleteAfterMessage(sessionId: string, messageId: string, messageTimestamp: string): void {
		const db = getDatabase();

		// Delete snapshots created at and after this message
		db.prepare(`
			DELETE FROM message_snapshots
			WHERE session_id = ?
			AND created_at >= ?
		`).run(sessionId, messageTimestamp);
	},

	/**
	 * Soft delete snapshots after a certain checkpoint message (for undo with branch support)
	 * Deletes snapshots from next user message onward, preserving checkpoint conversation snapshots
	 */
	softDeleteAfterMessage(sessionId: string, checkpointTimestamp: string, branchId: string): void {
		const db = getDatabase();

		// Get snapshots with their associated messages to determine type
		const allSnapshots = db.prepare(`
			SELECT ms.id, ms.created_at, ms.message_id, m.sdk_message
			FROM message_snapshots ms
			JOIN messages m ON ms.message_id = m.id
			WHERE ms.session_id = ?
			ORDER BY ms.created_at ASC
		`).all(sessionId) as { id: string; created_at: string; message_id: string; sdk_message: string }[];

		// Find the checkpoint snapshot index
		const checkpointIndex = allSnapshots.findIndex(snap => snap.created_at === checkpointTimestamp);

		if (checkpointIndex === -1) {
			debug.warn('database', `Checkpoint snapshot with timestamp ${checkpointTimestamp} not found`);
			return;
		}

		// Find next USER message snapshot after checkpoint
		let deleteFromIndex = -1;
		for (let i = checkpointIndex + 1; i < allSnapshots.length; i++) {
			const sdkMessage = JSON.parse(allSnapshots[i].sdk_message);
			if (sdkMessage.type === 'user') {
				deleteFromIndex = i;
				break;
			}
		}

		// If no user message snapshot found after checkpoint, nothing to delete
		if (deleteFromIndex === -1) {
			debug.log('database', 'No user message snapshots to soft delete after checkpoint');
			return;
		}

		// Get IDs of snapshots from next user message onward
		const snapshotsToDelete = allSnapshots
			.slice(deleteFromIndex)
			.map(snap => snap.id);

		if (snapshotsToDelete.length === 0) {
			debug.log('database', 'No snapshots to soft delete after checkpoint');
			return;
		}

		// Soft delete snapshots
		const placeholders = snapshotsToDelete.map(() => '?').join(',');
		db.prepare(`
			UPDATE message_snapshots
			SET is_deleted = 1, branch_id = ?
			WHERE id IN (${placeholders}) AND (is_deleted IS NULL OR is_deleted = 0)
		`).run(branchId, ...snapshotsToDelete);

		debug.log('database', `Soft deleted ${snapshotsToDelete.length} snapshots from next user message after checkpoint`);
	},

	/**
	 * Restore snapshots from a specific branch
	 */
	restoreBranchSnapshots(sessionId: string, branchId: string): void {
		const db = getDatabase();

		// Mark all current active snapshots as deleted
		db.prepare(`
			UPDATE message_snapshots
			SET is_deleted = 1
			WHERE session_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
		`).run(sessionId);

		// Restore snapshots from target branch
		db.prepare(`
			UPDATE message_snapshots
			SET is_deleted = 0
			WHERE session_id = ? AND branch_id = ?
		`).run(sessionId, branchId);

		// Restore snapshots on main branch up to branching point
		const firstBranchSnapshot = db.prepare(`
			SELECT MIN(created_at) as min_timestamp
			FROM message_snapshots
			WHERE session_id = ? AND branch_id = ?
		`).get(sessionId, branchId) as { min_timestamp: string } | undefined;

		if (firstBranchSnapshot?.min_timestamp) {
			db.prepare(`
				UPDATE message_snapshots
				SET is_deleted = 0
				WHERE session_id = ? AND (branch_id IS NULL OR branch_id = '') AND created_at < ?
			`).run(sessionId, firstBranchSnapshot.min_timestamp);
		}
	},

	/**
	 * Create session relationship
	 */
	createRelationship(data: {
		parent_session_id: string;
		child_session_id: string;
		branched_from_message_id?: string;
	}): SessionRelationship {
		const db = getDatabase();
		const id = `rel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const now = new Date().toISOString();

		const relationship: SessionRelationship = {
			id,
			parent_session_id: data.parent_session_id,
			child_session_id: data.child_session_id,
			branched_from_message_id: data.branched_from_message_id,
			created_at: now
		};

		db.prepare(`
			INSERT INTO session_relationships (
				id, parent_session_id, child_session_id,
				branched_from_message_id, created_at
			) VALUES (?, ?, ?, ?, ?)
		`).run(
			relationship.id,
			relationship.parent_session_id,
			relationship.child_session_id,
			relationship.branched_from_message_id || null,
			relationship.created_at
		);

		return relationship;
	},

	/**
	 * Get relationship by child session ID
	 */
	getRelationshipByChildId(childSessionId: string): SessionRelationship | null {
		const db = getDatabase();
		const relationship = db.prepare(`
			SELECT * FROM session_relationships WHERE child_session_id = ?
		`).get(childSessionId) as SessionRelationship | null;

		return relationship;
	},

	/**
	 * Get all child sessions of a parent
	 */
	getChildSessions(parentSessionId: string): SessionRelationship[] {
		const db = getDatabase();
		const relationships = db.prepare(`
			SELECT * FROM session_relationships
			WHERE parent_session_id = ?
			ORDER BY created_at ASC
		`).all(parentSessionId) as SessionRelationship[];

		return relationships;
	},

	/**
	 * Get complete session tree for a project
	 * Returns all relationships for building a timeline
	 */
	getSessionTree(projectId: string): SessionRelationship[] {
		const db = getDatabase();
		const relationships = db.prepare(`
			SELECT sr.*
			FROM session_relationships sr
			INNER JOIN chat_sessions cs ON sr.parent_session_id = cs.id
			WHERE cs.project_id = ?
			ORDER BY sr.created_at ASC
		`).all(projectId) as SessionRelationship[];

		return relationships;
	}
};