/**
 * Snapshot Service for Time Travel Feature
 *
 * Uses git-like content-addressable blob storage for efficient snapshots:
 * - File contents stored as compressed blobs in ~/.clopen/snapshots/blobs/
 * - Each snapshot has a tree file mapping filepath -> blob hash
 * - DB only stores lightweight metadata and hash references
 * - Deduplication: identical file content across snapshots stored once
 * - mtime cache: skip re-reading files that haven't changed
 * - Respects .gitignore rules (via git ls-files or manual parsing)
 * - All files read/written as Buffer (binary-safe for images, PDFs, etc.)
 */

import fs from 'fs/promises';
import path from 'path';
import { snapshotQueries } from '../database/queries';
import { blobStore, type TreeMap } from './blob-store';
import { getSnapshotFiles } from './gitignore';
import type { MessageSnapshot, DeltaChanges } from '$shared/types/database/schema';
import { calculateFileChangeStats } from '$shared/utils/diff-calculator';
import { debug } from '$shared/utils/logger';

interface FileSnapshot {
	[filepath: string]: Buffer; // filepath -> content (Buffer for binary safety)
}

interface SnapshotMetadata {
	totalFiles: number;
	totalSize: number;
	capturedAt: string;
	snapshotType: 'full' | 'delta';
	deltaSize?: number;
	storageFormat?: 'blob-store';
}

// Maximum file size to include (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export class SnapshotService {
	private static instance: SnapshotService;

	private constructor() {}

	static getInstance(): SnapshotService {
		if (!SnapshotService.instance) {
			SnapshotService.instance = new SnapshotService();
		}
		return SnapshotService.instance;
	}

	/**
	 * Capture snapshot of current project state using blob store.
	 * Only changed files are read and stored (mtime cache + hash dedup).
	 * Respects .gitignore rules for file exclusion.
	 */
	async captureSnapshot(
		projectPath: string,
		projectId: string,
		sessionId: string,
		messageId: string
	): Promise<MessageSnapshot> {
		try {
			// Scan files respecting .gitignore (git ls-files or manual parsing)
			const files = await getSnapshotFiles(projectPath);

			// Build current tree: hash each file using blob store
			const currentTree: TreeMap = {};
			const readContents = new Map<string, Buffer>();
			let totalSize = 0;

			for (const filepath of files) {
				try {
					const stat = await fs.stat(filepath);
					if (stat.size > MAX_FILE_SIZE) {
						debug.warn('snapshot', `Skipping large file: ${filepath} (${stat.size} bytes)`);
						continue;
					}

					const relativePath = path.relative(projectPath, filepath);
					const normalizedPath = relativePath.replace(/\\/g, '/');

					const result = await blobStore.hashFile(normalizedPath, filepath);
					currentTree[normalizedPath] = result.hash;
					totalSize += stat.size;

					if (result.content !== null) {
						readContents.set(normalizedPath, result.content);
					}
				} catch (error) {
					debug.warn('snapshot', `Could not process file ${filepath}:`, error);
				}
			}

			// Get previous snapshot's tree for delta computation
			const previousSnapshots = snapshotQueries.getBySessionId(sessionId);
			const previousSnapshot = previousSnapshots.length > 0
				? previousSnapshots[previousSnapshots.length - 1]
				: null;

			let previousTree: TreeMap = {};
			if (previousSnapshot) {
				previousTree = await this.getSnapshotTree(previousSnapshot);
			}

			// Compute delta by comparing tree hashes (fast!)
			const delta = this.calculateTreeDelta(previousTree, currentTree);
			const deltaSize =
				Object.keys(delta.added).length +
				Object.keys(delta.modified).length +
				delta.deleted.length;

			// Calculate line-level file change stats for changed files only
			const fileStats = await this.calculateChangeStats(
				previousTree, currentTree, delta, readContents
			);

			const metadata: SnapshotMetadata = {
				totalFiles: Object.keys(currentTree).length,
				totalSize,
				capturedAt: new Date().toISOString(),
				snapshotType: 'delta',
				deltaSize,
				storageFormat: 'blob-store'
			};

			const snapshotId = `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			// Store tree file to disk
			const treeHash = await blobStore.storeTree(snapshotId, currentTree);

			// Store lightweight record in DB (no file content!)
			const dbSnapshot = snapshotQueries.createSnapshot({
				id: snapshotId,
				message_id: messageId,
				session_id: sessionId,
				project_id: projectId,
				files_snapshot: {},
				project_metadata: metadata,
				snapshot_type: 'delta',
				parent_snapshot_id: previousSnapshot?.id,
				delta_changes: delta,
				files_changed: fileStats.filesChanged,
				insertions: fileStats.insertions,
				deletions: fileStats.deletions,
				tree_hash: treeHash
			});

			const typeLabel = previousSnapshot ? 'delta' : 'initial delta';
			debug.log('snapshot', `Created ${typeLabel} snapshot [blob-store]: ${deltaSize} changes (${Object.keys(delta.added).length} added, ${Object.keys(delta.modified).length} modified, ${delta.deleted.length} deleted) - ${fileStats.filesChanged} files, +${fileStats.insertions}/-${fileStats.deletions} lines`);
			return dbSnapshot;
		} catch (error) {
			debug.error('snapshot', 'Error capturing snapshot:', error);
			throw new Error(`Failed to capture snapshot: ${error}`);
		}
	}

	/**
	 * Calculate delta between two trees by comparing hashes.
	 */
	private calculateTreeDelta(
		previousTree: TreeMap,
		currentTree: TreeMap
	): DeltaChanges {
		const delta: DeltaChanges = {
			added: {},
			modified: {},
			deleted: []
		};

		for (const [filepath, hash] of Object.entries(currentTree)) {
			if (!previousTree[filepath]) {
				delta.added[filepath] = hash;
			} else if (previousTree[filepath] !== hash) {
				delta.modified[filepath] = hash;
			}
		}

		for (const filepath of Object.keys(previousTree)) {
			if (!currentTree[filepath]) {
				delta.deleted.push(filepath);
			}
		}

		return delta;
	}

	/**
	 * Calculate line-level change stats for changed files.
	 * Only reads blob content for files that actually changed.
	 */
	private async calculateChangeStats(
		previousTree: TreeMap,
		currentTree: TreeMap,
		delta: DeltaChanges,
		readContents: Map<string, Buffer>
	): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
		const previousSnapshot: Record<string, Buffer> = {};
		const currentSnapshot: Record<string, Buffer> = {};

		for (const filepath of Object.keys(delta.added)) {
			const hash = currentTree[filepath];
			currentSnapshot[filepath] = readContents.get(filepath) ?? await blobStore.readBlob(hash);
		}

		for (const filepath of Object.keys(delta.modified)) {
			const oldHash = previousTree[filepath];
			const newHash = currentTree[filepath];
			previousSnapshot[filepath] = await blobStore.readBlob(oldHash);
			currentSnapshot[filepath] = readContents.get(filepath) ?? await blobStore.readBlob(newHash);
		}

		for (const filepath of delta.deleted) {
			const oldHash = previousTree[filepath];
			if (oldHash) {
				previousSnapshot[filepath] = await blobStore.readBlob(oldHash);
			}
		}

		return calculateFileChangeStats(previousSnapshot, currentSnapshot);
	}

	/**
	 * Get the tree map for a snapshot.
	 * New format: read from tree file on disk.
	 * Old format: reconstruct from delta chain in DB.
	 */
	private async getSnapshotTree(snapshot: MessageSnapshot): Promise<TreeMap> {
		if (snapshot.tree_hash) {
			try {
				return await blobStore.readTree(snapshot.id);
			} catch (err) {
				debug.warn('snapshot', `Could not read tree file for ${snapshot.id}, falling back to chain replay:`, err);
			}
		}

		// Old format: reconstruct complete state from delta chain (returns string content)
		const fileSnapshot = await this.reconstructSnapshotLegacy(snapshot);

		// Convert legacy FileSnapshot to TreeMap by hashing and storing each file as blob
		const tree: TreeMap = {};
		for (const [filepath, content] of Object.entries(fileSnapshot)) {
			const hash = await blobStore.storeBlob(content);
			tree[filepath] = hash;
		}
		return tree;
	}

	/**
	 * Restore project to a previous snapshot.
	 * Only modifies files that are different from current state.
	 * Uses .gitignore-aware scanning for current state comparison.
	 */
	async restoreSnapshot(
		projectPath: string,
		snapshot: MessageSnapshot
	): Promise<void> {
		try {
			const targetState = await this.reconstructSnapshot(snapshot);

			// Scan current files respecting .gitignore
			const currentFiles = await getSnapshotFiles(projectPath);
			const currentState = await this.createFileSnapshot(projectPath, currentFiles);

			let restoredCount = 0;
			let deletedCount = 0;

			debug.log('snapshot', 'SNAPSHOT RESTORE START');
			debug.log('snapshot', `Snapshot ID: ${snapshot.id}`);
			debug.log('snapshot', `Message ID: ${snapshot.message_id}`);
			debug.log('snapshot', `Project path: ${projectPath}`);
			debug.log('snapshot', `Target state files: ${Object.keys(targetState).length}`);
			debug.log('snapshot', `Current state files: ${currentFiles.length}`);

			// Delete files that exist now but not in target state
			for (const currentFile of currentFiles) {
				const relativePath = path.relative(projectPath, currentFile);
				const normalizedPath = relativePath.replace(/\\/g, '/');

				if (!targetState[normalizedPath]) {
					try {
						await fs.unlink(currentFile);
						debug.log('snapshot', `Deleted: ${currentFile}`);
						deletedCount++;
					} catch (err) {
						debug.warn('snapshot', `Could not delete ${currentFile}:`, err);
					}
				}
			}

			// Write only files that are different or don't exist
			for (const [relativePath, targetContent] of Object.entries(targetState)) {
				const fullPath = path.join(projectPath, relativePath);
				const currentContent = currentState[relativePath];

				// Compare as Buffer (binary-safe comparison)
				const isDifferent = !currentContent || !currentContent.equals(targetContent);

				if (isDifferent) {
					const dir = path.dirname(fullPath);
					await fs.mkdir(dir, { recursive: true });
					// Write as Buffer directly — no encoding, preserves binary files
					await fs.writeFile(fullPath, targetContent);

					const action = currentContent === undefined ? 'Created' : 'Modified';
					debug.log('snapshot', `${action}: ${fullPath}`);
					restoredCount++;
				}
			}

			debug.log('snapshot', `Project restored successfully: ${restoredCount} files restored, ${deletedCount} files deleted`);
			debug.log('snapshot', 'SNAPSHOT RESTORE COMPLETE');
		} catch (error) {
			debug.error('snapshot', 'Error restoring snapshot:', error);
			throw new Error(`Failed to restore snapshot: ${error}`);
		}
	}

	/**
	 * Reconstruct the complete file state from a snapshot.
	 * New format (tree_hash): Read tree -> resolve blobs (O(1), no chain replay).
	 * Old format: Replay delta chain from root (legacy).
	 */
	private async reconstructSnapshot(snapshot: MessageSnapshot): Promise<FileSnapshot> {
		if (snapshot.tree_hash) {
			try {
				const tree = await blobStore.readTree(snapshot.id);
				return await blobStore.resolveTree(tree);
			} catch (err) {
				debug.warn('snapshot', `Could not resolve tree for ${snapshot.id}, falling back to legacy:`, err);
			}
		}

		return this.reconstructSnapshotLegacy(snapshot);
	}

	/**
	 * Legacy reconstruction: replay all deltas from root to target snapshot.
	 */
	private async reconstructSnapshotLegacy(snapshot: MessageSnapshot): Promise<FileSnapshot> {
		const chain = await this.getSnapshotChain(snapshot);
		let state: FileSnapshot = {};

		for (const deltaSnapshot of chain) {
			if (!deltaSnapshot.delta_changes) {
				debug.warn('snapshot', `Delta snapshot ${deltaSnapshot.id} missing delta_changes`);
				continue;
			}

			const delta = JSON.parse(deltaSnapshot.delta_changes) as DeltaChanges;
			state = this.applyDelta(state, delta);
		}

		return state;
	}

	/**
	 * Get the chain of snapshots from the first snapshot to the target.
	 */
	private async getSnapshotChain(targetSnapshot: MessageSnapshot): Promise<MessageSnapshot[]> {
		const chain: MessageSnapshot[] = [];
		let current: MessageSnapshot | null = targetSnapshot;

		while (current) {
			chain.unshift(current);

			if (!current.parent_snapshot_id) {
				break;
			}

			const parent = snapshotQueries.getById(current.parent_snapshot_id);
			if (!parent) {
				throw new Error(`Parent snapshot ${current.parent_snapshot_id} not found`);
			}

			current = parent;
		}

		return chain;
	}

	/**
	 * Apply a delta to a file state (legacy format - full content in delta as strings).
	 * Converts string content to Buffer for the new binary-safe interface.
	 */
	private applyDelta(state: FileSnapshot, delta: DeltaChanges): FileSnapshot {
		const newState = { ...state };

		for (const [filepath, content] of Object.entries(delta.added)) {
			newState[filepath] = Buffer.from(content, 'utf-8');
		}

		for (const [filepath, content] of Object.entries(delta.modified)) {
			newState[filepath] = Buffer.from(content, 'utf-8');
		}

		for (const filepath of delta.deleted) {
			delete newState[filepath];
		}

		return newState;
	}

	/**
	 * Get diff between current state and a snapshot
	 */
	async getDiff(
		projectPath: string,
		snapshot: MessageSnapshot
	): Promise<{
		added: string[];
		modified: string[];
		deleted: string[];
	}> {
		try {
			const snapshotFiles = await this.reconstructSnapshot(snapshot);
			const currentSnapshot = await this.createFileSnapshot(
				projectPath,
				await getSnapshotFiles(projectPath)
			);

			const added: string[] = [];
			const modified: string[] = [];
			const deleted: string[] = [];

			for (const [filepath, content] of Object.entries(currentSnapshot)) {
				if (!snapshotFiles[filepath]) {
					added.push(filepath);
				} else if (!snapshotFiles[filepath].equals(content)) {
					modified.push(filepath);
				}
			}

			for (const filepath of Object.keys(snapshotFiles)) {
				if (!currentSnapshot[filepath]) {
					deleted.push(filepath);
				}
			}

			return { added, modified, deleted };
		} catch (error) {
			debug.error('snapshot', 'Error getting diff:', error);
			throw new Error(`Failed to get diff: ${error}`);
		}
	}

	/**
	 * Create snapshot of file contents (used for restore comparison and getDiff).
	 * Reads as Buffer for binary-safe handling.
	 */
	private async createFileSnapshot(
		projectPath: string,
		files: string[]
	): Promise<FileSnapshot> {
		const snapshot: FileSnapshot = {};

		for (const filepath of files) {
			try {
				const stats = await fs.stat(filepath);
				if (stats.size > MAX_FILE_SIZE) continue;

				// Read as Buffer — no encoding, preserves binary files
				const content = await fs.readFile(filepath);
				const relativePath = path.relative(projectPath, filepath);
				const normalizedPath = relativePath.replace(/\\/g, '/');
				snapshot[normalizedPath] = content;
			} catch (error) {
				debug.warn('snapshot', `Could not read file ${filepath}:`, error);
			}
		}

		return snapshot;
	}

	/**
	 * Clean up old snapshots (older than 30 days)
	 */
	async cleanupOldSnapshots(): Promise<void> {
		// This could be implemented later if needed
	}
}

// Export singleton instance
export const snapshotService = SnapshotService.getInstance();
