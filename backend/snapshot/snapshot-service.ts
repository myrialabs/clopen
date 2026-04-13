/**
 * Snapshot Service for Time Travel Feature (v2 - Session-Scoped)
 *
 * Architecture:
 * - Session baseline: hash-only scan at session start, background blob storage
 * - Per-checkpoint delta: only stores files that changed during the stream
 * - Session-scoped restore: bidirectional (forward + backward) using session_changes
 * - Cross-session conflict detection: warns when restoring would affect other sessions' changes
 *
 * Storage:
 * - Blob store: ~/.clopen/snapshots/blobs/ (content-addressable, deduped, gzipped)
 * - DB: lightweight metadata + session_changes JSON
 */

import fs from 'fs/promises';
import path from 'path';
import { snapshotQueries, sessionQueries, messageQueries } from '../database/queries';
import { getDatabase } from '../database/index';
import { blobStore, type TreeMap } from './blob-store';
import { getSnapshotFiles } from './gitignore';
import { fileWatcher } from '../files/file-watcher';
import type { MessageSnapshot, SessionScopedChanges } from '$shared/types/database/schema';
import { calculateFileChangeStats } from '$shared/utils/diff-calculator';
import { debug } from '$shared/utils/logger';

interface SnapshotMetadata {
	totalFiles: number;
	totalSize: number;
	capturedAt: string;
	snapshotType: 'delta';
	deltaSize?: number;
	storageFormat: 'blob-store';
}

// Maximum file size to include (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Conflict information for a single file during restore
 */
export interface RestoreConflict {
	filepath: string;
	modifiedBySessionId: string;
	modifiedBySnapshotId: string;
	modifiedAt: string;
	restoreContent?: string;
	currentContent?: string;
}

/**
 * Result of conflict detection before restore
 */
export interface RestoreConflictCheck {
	hasConflicts: boolean;
	conflicts: RestoreConflict[];
	checkpointsToUndo: string[];
}

/**
 * User's resolution decision for each conflicting file
 */
export interface ConflictResolution {
	[filepath: string]: 'restore' | 'keep';
}

export class SnapshotService {
	private static instance: SnapshotService;

	/**
	 * Per-session running tree: sessionId → TreeMap
	 * Updated after each capture and restore.
	 */
	private sessionBaselines = new Map<string, TreeMap>();

	private constructor() {}

	static getInstance(): SnapshotService {
		if (!SnapshotService.instance) {
			SnapshotService.instance = new SnapshotService();
		}
		return SnapshotService.instance;
	}

	// ========================================================================
	// Session Baseline
	// ========================================================================

	/**
	 * Initialize session baseline: hash-only scan + blob storage.
	 * Called when a session is first activated for a project.
	 */
	async initializeSessionBaseline(
		projectPath: string,
		sessionId: string
	): Promise<void> {
		if (this.sessionBaselines.has(sessionId)) return;

		try {
			const files = await getSnapshotFiles(projectPath);
			const baseline: TreeMap = {};

			for (const filepath of files) {
				try {
					const stat = await fs.stat(filepath);
					if (stat.size > MAX_FILE_SIZE) continue;

					const relativePath = path.relative(projectPath, filepath);
					const normalizedPath = relativePath.replace(/\\/g, '/');

					const result = await blobStore.hashFile(normalizedPath, filepath);
					baseline[normalizedPath] = result.hash;
				} catch {
					// Skip unreadable files
				}
			}

			this.sessionBaselines.set(sessionId, baseline);
			debug.log('snapshot', `Session baseline initialized: ${Object.keys(baseline).length} files for session ${sessionId}`);
		} catch (error) {
			debug.error('snapshot', 'Error initializing session baseline:', error);
		}
	}

	private async getSessionBaseline(
		projectPath: string,
		sessionId: string
	): Promise<TreeMap> {
		if (!this.sessionBaselines.has(sessionId)) {
			await this.initializeSessionBaseline(projectPath, sessionId);
		}
		return this.sessionBaselines.get(sessionId) || {};
	}

	// ========================================================================
	// Snapshot Capture
	// ========================================================================

	/**
	 * Capture snapshot of current project state.
	 * Only processes files detected as dirty by the file watcher.
	 * Stores session-scoped changes (oldHash/newHash per file).
	 */
	async captureSnapshot(
		projectPath: string,
		projectId: string,
		sessionId: string,
		messageId: string
	): Promise<MessageSnapshot> {
		try {
			const dirtyFiles = fileWatcher.getDirtyFiles(projectId);

			const previousSnapshots = snapshotQueries.getBySessionId(sessionId);
			const previousSnapshot = previousSnapshots.length > 0
				? previousSnapshots[previousSnapshots.length - 1]
				: null;

			// FAST PATH: no file changes detected → skip snapshot
			if (dirtyFiles.size === 0 && previousSnapshot) {
				debug.log('snapshot', 'No file changes detected, skipping snapshot');
				return previousSnapshot;
			}

			// Get previous tree (in-memory baseline)
			const previousTree = await this.getSessionBaseline(projectPath, sessionId);

			// Build current tree incrementally
			let currentTree: TreeMap;
			const sessionChanges: SessionScopedChanges = {};
			const readContents = new Map<string, Buffer>();

			if (dirtyFiles.size === 0 && !previousSnapshot) {
				// First snapshot ever, no dirty files → initial baseline
				currentTree = { ...previousTree };
			} else if (dirtyFiles.size > 0) {
				// Incremental: start from previous tree, update only dirty files
				currentTree = { ...previousTree };

				for (const relativePath of dirtyFiles) {
					const fullPath = path.join(projectPath, relativePath);

					try {
						const stat = await fs.stat(fullPath);
						if (stat.size > MAX_FILE_SIZE) {
							if (currentTree[relativePath]) {
								const oldHash = currentTree[relativePath];
								sessionChanges[relativePath] = { oldHash, newHash: '' };
								delete currentTree[relativePath];
							}
							continue;
						}

						const result = await blobStore.hashFile(relativePath, fullPath);
						const newHash = result.hash;
						const oldHash = previousTree[relativePath] || '';

						if (oldHash !== newHash) {
							currentTree[relativePath] = newHash;
							sessionChanges[relativePath] = { oldHash, newHash };

							if (result.content !== null) {
								readContents.set(relativePath, result.content);
							}

							if (oldHash && !(await blobStore.hasBlob(oldHash))) {
								debug.warn('snapshot', `Old blob missing for ${relativePath} (${oldHash.slice(0, 8)}), restore may be limited`);
							}
						}
					} catch {
						// File was deleted
						if (currentTree[relativePath]) {
							const oldHash = currentTree[relativePath];
							sessionChanges[relativePath] = { oldHash, newHash: '' };
							delete currentTree[relativePath];
						}
					}
				}
			} else {
				currentTree = { ...previousTree };
			}

			fileWatcher.clearDirtyFiles(projectId);

			// If no actual changes after processing, skip
			if (Object.keys(sessionChanges).length === 0 && previousSnapshot) {
				debug.log('snapshot', 'No actual file changes after hash comparison, skipping snapshot');
				return previousSnapshot;
			}

			// Calculate line-level file change stats
			const fileStats = await this.calculateChangeStats(
				previousTree, currentTree, sessionChanges, readContents
			);

			const metadata: SnapshotMetadata = {
				totalFiles: Object.keys(currentTree).length,
				totalSize: 0,
				capturedAt: new Date().toISOString(),
				snapshotType: 'delta',
				deltaSize: Object.keys(sessionChanges).length,
				storageFormat: 'blob-store'
			};

			const snapshotId = `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			// Update in-memory baseline
			this.sessionBaselines.set(sessionId, { ...currentTree });

			const dbSnapshot = snapshotQueries.createSnapshot({
				id: snapshotId,
				message_id: messageId,
				session_id: sessionId,
				project_id: projectId,
				files_snapshot: {},
				project_metadata: metadata,
				snapshot_type: 'delta',
				parent_snapshot_id: previousSnapshot?.id,
				delta_changes: {},
				files_changed: fileStats.filesChanged,
				insertions: fileStats.insertions,
				deletions: fileStats.deletions,
				tree_hash: undefined,
				session_changes: sessionChanges
			});

			const changesCount = Object.keys(sessionChanges).length;
			debug.log('snapshot', `Snapshot captured: ${changesCount} changes - ${fileStats.filesChanged} files, +${fileStats.insertions}/-${fileStats.deletions} lines`);
			return dbSnapshot;
		} catch (error) {
			debug.error('snapshot', 'Error capturing snapshot:', error);
			throw new Error(`Failed to capture snapshot: ${error}`);
		}
	}

	// ========================================================================
	// Conflict Detection
	// ========================================================================

	/**
	 * Check for conflicts before restoring to a checkpoint.
	 * Works bidirectionally (undo and redo).
	 *
	 * A conflict occurs when a file that would be changed by the restore
	 * was also modified by a different session after the reference time.
	 * Reference time = min(targetTime, currentHeadTime) to cover both directions.
	 */
	async checkRestoreConflicts(
		sessionId: string,
		targetCheckpointMessageId: string | null,
		projectPath?: string,
		targetPath?: string[]
	): Promise<RestoreConflictCheck> {
		const sessionSnapshots = snapshotQueries.getBySessionId(sessionId);
		const isInitialRestore = targetCheckpointMessageId === null;

		// Build expected state at target (branch-aware when targetPath is provided)
		const expectedState = this.buildExpectedState(
			sessionSnapshots, targetCheckpointMessageId, targetPath
		);

		if (expectedState.size === 0) {
			return { hasConflicts: false, conflicts: [], checkpointsToUndo: [] };
		}

		// Filter out files already in expected state on disk (no actual change needed)
		if (projectPath) {
			for (const [filepath, expectedHash] of expectedState) {
				const fullPath = path.join(projectPath, filepath);
				let currentHash = '';
				try {
					const content = await fs.readFile(fullPath);
					currentHash = blobStore.hashContent(content);
				} catch {
					// File doesn't exist on disk
					currentHash = '';
				}
				if (currentHash === expectedHash) {
					expectedState.delete(filepath);
				}
			}

			if (expectedState.size === 0) {
				return { hasConflicts: false, conflicts: [], checkpointsToUndo: [] };
			}
		}

		// Determine reference time for cross-session conflict check
		// Use min(targetTime, currentHeadTime) to cover both undo and redo
		// For initial restore, use the session's created_at or the earliest snapshot time
		const targetSnapshot = isInitialRestore
			? null
			: sessionSnapshots.find(s => s.message_id === targetCheckpointMessageId) || null;
		const targetTime = targetSnapshot
			? targetSnapshot.created_at
			: (sessionSnapshots[0]?.created_at || new Date(0).toISOString());
		let referenceTime = targetTime;

		const currentHead = sessionQueries.getHead(sessionId);
		if (currentHead) {
			// Try direct match (HEAD is a checkpoint message with a snapshot)
			const directMatch = sessionSnapshots.find(s => s.message_id === currentHead);
			if (directMatch) {
				if (directMatch.created_at < targetTime) {
					referenceTime = directMatch.created_at;
				}
			} else {
				// HEAD is a session end (assistant msg), find its checkpoint snapshot
				const headMsg = messageQueries.getById(currentHead);
				if (headMsg) {
					for (let i = sessionSnapshots.length - 1; i >= 0; i--) {
						if (sessionSnapshots[i].created_at <= headMsg.created_at) {
							if (sessionSnapshots[i].created_at < targetTime) {
								referenceTime = sessionSnapshots[i].created_at;
							}
							break;
						}
					}
				}
			}
		}

		// Check for cross-session conflicts
		const conflicts: RestoreConflict[] = [];
		const projectId = targetSnapshot
			? targetSnapshot.project_id
			: (sessionSnapshots[0]?.project_id || '');
		const allProjectSnapshots = this.getAllProjectSnapshots(projectId);

		for (const otherSnap of allProjectSnapshots) {
			if (otherSnap.session_id === sessionId) continue;
			if (otherSnap.created_at <= referenceTime) continue;
			if (!otherSnap.session_changes) continue;

			try {
				const otherChanges = JSON.parse(otherSnap.session_changes) as SessionScopedChanges;
				for (const filepath of Object.keys(otherChanges)) {
					if (expectedState.has(filepath)) {
						conflicts.push({
							filepath,
							modifiedBySessionId: otherSnap.session_id,
							modifiedBySnapshotId: otherSnap.id,
							modifiedAt: otherSnap.created_at
						});
					}
				}
			} catch { /* skip malformed */ }
		}

		// Deduplicate by filepath (keep the most recent)
		const conflictMap = new Map<string, RestoreConflict>();
		for (const conflict of conflicts) {
			const existing = conflictMap.get(conflict.filepath);
			if (!existing || conflict.modifiedAt > existing.modifiedAt) {
				conflictMap.set(conflict.filepath, conflict);
			}
		}

		const uniqueConflicts = Array.from(conflictMap.values());

		// Populate file contents for diff display
		if (uniqueConflicts.length > 0 && projectPath) {
			await Promise.all(uniqueConflicts.map(async (conflict) => {
				const restoreHash = expectedState.get(conflict.filepath);
				if (restoreHash) {
					try {
						const restoreBuf = await blobStore.readBlob(restoreHash);
						conflict.restoreContent = restoreBuf.toString('utf-8');
					} catch {
						conflict.restoreContent = '(binary or unavailable)';
					}
				} else {
					conflict.restoreContent = '(file would be deleted)';
				}

				try {
					const fullPath = path.join(projectPath, conflict.filepath);
					const currentBuf = await fs.readFile(fullPath);
					conflict.currentContent = currentBuf.toString('utf-8');
				} catch {
					conflict.currentContent = '(file not found on disk)';
				}
			}));
		}

		// Collect affected snapshot IDs
		const affectedSnapshotIds = sessionSnapshots
			.filter(s => s.session_changes)
			.map(s => s.id);

		return {
			hasConflicts: uniqueConflicts.length > 0,
			conflicts: uniqueConflicts,
			checkpointsToUndo: affectedSnapshotIds
		};
	}

	private getAllProjectSnapshots(projectId: string): MessageSnapshot[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM message_snapshots
			WHERE project_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
			ORDER BY created_at ASC
		`).all(projectId) as MessageSnapshot[];
	}

	// ========================================================================
	// Session-Scoped Restore (Bidirectional)
	// ========================================================================

	/**
	 * Restore to a checkpoint using session-scoped changes.
	 * Works in both directions (forward and backward).
	 *
	 * When targetPath is provided, uses branch-aware algorithm:
	 * 1. Only apply changes from snapshots on the path (root → target)
	 * 2. Revert ALL changes from snapshots on other branches
	 * 3. Compare expected state with disk and restore if different
	 * 4. Update in-memory baseline to match restored state
	 *
	 * Falls back to linear algorithm when targetPath is not provided.
	 */
	async restoreSessionScoped(
		projectPath: string,
		sessionId: string,
		targetCheckpointMessageId: string | null,
		conflictResolutions?: ConflictResolution,
		targetPath?: string[]
	): Promise<{ restoredFiles: number; skippedFiles: number }> {
		try {
			const sessionSnapshots = snapshotQueries.getBySessionId(sessionId);

			// Build expected file state at the target checkpoint
			// Branch-aware when targetPath is provided
			const expectedState = this.buildExpectedState(
				sessionSnapshots, targetCheckpointMessageId, targetPath
			);

			debug.log('snapshot', `Restore to checkpoint: ${expectedState.size} files in expected state`);

			let restoredFiles = 0;
			let skippedFiles = 0;

			for (const [filepath, expectedHash] of expectedState) {
				// Check conflict resolution
				if (conflictResolutions && conflictResolutions[filepath] === 'keep') {
					debug.log('snapshot', `Skipping ${filepath} (user chose to keep)`);
					skippedFiles++;
					continue;
				}

				const fullPath = path.join(projectPath, filepath);

				// Check current disk state
				let currentHash = '';
				try {
					const content = await fs.readFile(fullPath);
					currentHash = blobStore.hashContent(content);
				} catch {
					// File doesn't exist on disk
					currentHash = '';
				}

				// Skip if already in expected state
				if (currentHash === expectedHash) continue;

				if (!expectedHash || expectedHash === '') {
					// File should not exist at the target → delete it
					try {
						await fs.unlink(fullPath);
						debug.log('snapshot', `Deleted: ${filepath}`);
						restoredFiles++;
					} catch {
						debug.warn('snapshot', `Could not delete ${filepath}`);
					}
				} else {
					// Restore file content from blob
					try {
						const content = await blobStore.readBlob(expectedHash);
						const dir = path.dirname(fullPath);
						await fs.mkdir(dir, { recursive: true });
						await fs.writeFile(fullPath, content);
						debug.log('snapshot', `Restored: ${filepath}`);
						restoredFiles++;
					} catch (err) {
						debug.warn('snapshot', `Could not restore ${filepath}:`, err);
						skippedFiles++;
					}
				}
			}

			// Force re-initialize baseline from actual disk state.
			// This is critical because:
			// 1. Files already at expected state were skipped (baseline not updated for them)
			// 2. After server restart, baseline starts empty — only restored files get entries
			// 3. Files not mentioned in any snapshot are missing from the partial baseline
			// Without this, subsequent captures would compute oldHash='' for files missing
			// from the baseline, causing future restores to incorrectly delete those files.
			this.sessionBaselines.delete(sessionId);
			await this.initializeSessionBaseline(projectPath, sessionId);

			debug.log('snapshot', `Restore complete: ${restoredFiles} restored, ${skippedFiles} skipped`);
			return { restoredFiles, skippedFiles };
		} catch (error) {
			debug.error('snapshot', 'Error in session-scoped restore:', error);
			throw new Error(`Failed to restore: ${error}`);
		}
	}

	// ========================================================================
	// Helpers
	// ========================================================================

	/**
	 * Build the expected file state map for a restore operation.
	 *
	 * Branch-aware algorithm (when targetPath is provided):
	 * 1. Separate snapshots into path (root→target) vs non-path
	 * 2. Forward walk: only apply newHash from snapshots on the path (in path order)
	 * 3. Revert walk: revert ALL non-path snapshots using oldHash (first-wins)
	 *
	 * This correctly handles multi-branch checkpoint trees by NOT including
	 * changes from other branches in the forward walk.
	 *
	 * Fallback linear algorithm (when targetPath is not provided):
	 * Walks all snapshots chronologically — only correct for single-branch paths.
	 */
	private buildExpectedState(
		sessionSnapshots: MessageSnapshot[],
		targetCheckpointMessageId: string | null,
		targetPath?: string[]
	): Map<string, string> {
		const expectedState = new Map<string, string>();
		const isInitialRestore = targetCheckpointMessageId === null;

		if (isInitialRestore) {
			// Revert ALL snapshots → everything goes back to oldHash (first-wins)
			for (const snap of sessionSnapshots) {
				if (!snap.session_changes) continue;
				try {
					const changes = JSON.parse(snap.session_changes as string) as SessionScopedChanges;
					for (const [filepath, change] of Object.entries(changes)) {
						if (!expectedState.has(filepath)) {
							expectedState.set(filepath, change.oldHash);
						}
					}
				} catch { /* skip malformed */ }
			}
		} else if (targetPath && targetPath.length > 0) {
			// Branch-aware restore: only include snapshots on the path from root to target
			const pathSet = new Set(targetPath);

			// Separate snapshots into path vs non-path
			const snapshotByMsgId = new Map<string, MessageSnapshot>();
			const nonPathSnapshots: MessageSnapshot[] = [];

			for (const snap of sessionSnapshots) {
				if (pathSet.has(snap.message_id)) {
					snapshotByMsgId.set(snap.message_id, snap);
				} else {
					nonPathSnapshots.push(snap);
				}
			}

			// Forward walk: apply path snapshots in path order (root → target)
			// Later path snapshots overwrite earlier ones for the same file (correct)
			for (const cpId of targetPath) {
				const snap = snapshotByMsgId.get(cpId);
				if (!snap?.session_changes) continue;
				try {
					const changes = JSON.parse(snap.session_changes as string) as SessionScopedChanges;
					for (const [filepath, change] of Object.entries(changes)) {
						expectedState.set(filepath, change.newHash);
					}
				} catch { /* skip malformed */ }
			}

			// Revert all non-path snapshots (changes on other branches)
			// Process in chronological order with first-wins semantics:
			// if two non-path snapshots change the same file, the earliest one's
			// oldHash is used (state before any branch diverged)
			for (const snap of nonPathSnapshots) {
				if (!snap.session_changes) continue;
				try {
					const changes = JSON.parse(snap.session_changes as string) as SessionScopedChanges;
					for (const [filepath, change] of Object.entries(changes)) {
						if (!expectedState.has(filepath)) {
							expectedState.set(filepath, change.oldHash);
						}
					}
				} catch { /* skip malformed */ }
			}
		} else {
			// Fallback: linear algorithm (no path info available)
			const targetIndex = sessionSnapshots.findIndex(
				s => s.message_id === targetCheckpointMessageId
			);

			if (targetIndex === -1) {
				debug.warn('snapshot', 'Target checkpoint snapshot not found (linear fallback)');
				return expectedState;
			}

			for (let i = 0; i <= targetIndex; i++) {
				const snap = sessionSnapshots[i];
				if (!snap.session_changes) continue;
				try {
					const changes = JSON.parse(snap.session_changes as string) as SessionScopedChanges;
					for (const [filepath, change] of Object.entries(changes)) {
						expectedState.set(filepath, change.newHash);
					}
				} catch { /* skip malformed */ }
			}

			for (let i = targetIndex + 1; i < sessionSnapshots.length; i++) {
				const snap = sessionSnapshots[i];
				if (!snap.session_changes) continue;
				try {
					const changes = JSON.parse(snap.session_changes as string) as SessionScopedChanges;
					for (const [filepath, change] of Object.entries(changes)) {
						if (!expectedState.has(filepath)) {
							expectedState.set(filepath, change.oldHash);
						}
					}
				} catch { /* skip malformed */ }
			}
		}

		return expectedState;
	}

	/**
	 * Calculate line-level change stats for changed files.
	 */
	private async calculateChangeStats(
		previousTree: TreeMap,
		currentTree: TreeMap,
		sessionChanges: SessionScopedChanges,
		readContents: Map<string, Buffer>
	): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
		const previousSnapshot: Record<string, Buffer> = {};
		const currentSnapshot: Record<string, Buffer> = {};

		for (const [filepath, change] of Object.entries(sessionChanges)) {
			try {
				if (change.oldHash) {
					previousSnapshot[filepath] = await blobStore.readBlob(change.oldHash);
				}
				if (change.newHash) {
					currentSnapshot[filepath] = readContents.get(filepath) ?? await blobStore.readBlob(change.newHash);
				}
			} catch { /* skip */ }
		}

		return calculateFileChangeStats(previousSnapshot, currentSnapshot);
	}

	/**
	 * Get all blob hashes from the in-memory baseline for a session.
	 * Must be called BEFORE clearSessionBaseline.
	 */
	getSessionBaselineHashes(sessionId: string): Set<string> {
		const baseline = this.sessionBaselines.get(sessionId);
		if (!baseline) return new Set();
		return new Set(Object.values(baseline));
	}

	/**
	 * Get all blob hashes from ALL in-memory baselines (all active sessions).
	 * Used to protect blobs still needed by other sessions during cleanup.
	 */
	getAllBaselineHashes(): Set<string> {
		const hashes = new Set<string>();
		for (const baseline of this.sessionBaselines.values()) {
			for (const hash of Object.values(baseline)) {
				hashes.add(hash);
			}
		}
		return hashes;
	}

	/**
	 * Clean up session baseline cache when session is no longer active.
	 */
	clearSessionBaseline(sessionId: string): void {
		this.sessionBaselines.delete(sessionId);
	}
}

// Export singleton instance
export const snapshotService = SnapshotService.getInstance();
