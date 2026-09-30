/**
 * Snapshot Service for Time Travel Feature (v2 - Session-Scoped)
 *
 * Architecture:
 * - Turn baseline: full scan at the start of EVERY turn (blob-stored)
 * - Per-checkpoint delta: files that changed during the turn, minus what git
 *   (see git-attribution.ts) and other chats in the same workspace account for
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
import { scanSnapshotFiles } from './gitignore';
import { attributeGitChanges, readRepoHeads, type RepoHeads } from './git-attribution';
import { TurnActivity, type ObservedOutput } from './turn-activity';
import { fileWatcher } from '../files/file-watcher';
import type { MessageSnapshot, SessionScopedChanges } from '$shared/types/database/schema';
import { calculateFileChangeStats } from '$shared/utils/diff-calculator';
import { makeScopeKey } from '$shared/utils/workspace-scope';
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
	/**
	 * 'cross-session' (default): file was changed by a different session after the
	 * reference time. 'local': the current on-disk content was never captured by
	 * this session's snapshots, so restoring would overwrite an unrecoverable
	 * manual edit.
	 */
	reason?: 'cross-session' | 'local';
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

/** Files hashed at once during a scan: hides stat/read latency without exhausting handles. */
const SCAN_CONCURRENCY = 32;

/**
 * What a running turn recorded when it began. Everything the capture needs to
 * tell the turn's own changes from everybody else's.
 */
interface TurnState {
	root: string;
	projectId: string;
	worktreeId: string | null;
	scopeKey: string;
	/** Epoch ms, taken before the baseline scan so nothing slips between them. */
	startedAt: number;
	/** HEAD of every repository in the project, for {@link attributeGitChanges}. */
	heads: RepoHeads;
	/** When this turn's tools were running. See turn-activity.ts. */
	activity: TurnActivity;
}

function isMissingFile(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

async function forEachConcurrently<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++];
			await work(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Everything that differs between two trees, as oldHash/newHash pairs. */
function diffTrees(before: TreeMap, after: TreeMap): SessionScopedChanges {
	const changes: SessionScopedChanges = {};
	for (const [filepath, newHash] of Object.entries(after)) {
		const oldHash = before[filepath] || '';
		if (oldHash !== newHash) changes[filepath] = { oldHash, newHash };
	}
	for (const [filepath, oldHash] of Object.entries(before)) {
		if (!(filepath in after)) changes[filepath] = { oldHash, newHash: '' };
	}
	return changes;
}

export class SnapshotService {
	private static instance: SnapshotService;

	/**
	 * Per-session tree: sessionId → TreeMap. Re-taken at the start of every
	 * turn, and after each capture and restore.
	 */
	private sessionBaselines = new Map<string, TreeMap>();

	/** Turns currently running, by session. */
	private activeTurns = new Map<string, TurnState>();

	/**
	 * Per-session work queue. A turn's baseline, its capture and a restore
	 * all read and replace the same tree, and they must not interleave: a
	 * capture still scanning when the next turn begins would fold that turn's
	 * first writes into the one before it.
	 */
	private sessionQueues = new Map<string, Promise<void>>();

	private constructor() {}

	static getInstance(): SnapshotService {
		if (!SnapshotService.instance) {
			SnapshotService.instance = new SnapshotService();
		}
		return SnapshotService.instance;
	}

	private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
		const result = previous.then(work);
		const tail = result.then(() => undefined, () => undefined);
		this.sessionQueues.set(sessionId, tail);
		void tail.then(() => {
			if (this.sessionQueues.get(sessionId) === tail) this.sessionQueues.delete(sessionId);
		});
		return result;
	}

	// ========================================================================
	// Scanning
	// ========================================================================

	/**
	 * Hash every snapshot-eligible file under `root`.
	 *
	 * `previous` is the tree this scan replaces, and it decides what a file
	 * that cannot be read right now becomes: whatever it was. Only a file that
	 * is really gone is left out — anything else (a directory git or the OS
	 * could not list, a permission error, a file that grew past the size cap)
	 * used to fall out of the tree and be recorded as a deletion, which a later
	 * restore would then carry out.
	 */
	private async scanTree(
		root: string,
		previous: TreeMap
	): Promise<{ tree: TreeMap; contents: Map<string, Buffer> }> {
		const scan = await scanSnapshotFiles(root, { pruneGenerated: true });
		if (scan.incomplete.includes('')) {
			throw new Error(`Could not list the files of ${root}`);
		}

		const tree: TreeMap = {};
		const contents = new Map<string, Buffer>();

		if (scan.incomplete.length > 0) {
			for (const [filepath, hash] of Object.entries(previous)) {
				if (scan.incomplete.some((dir) => filepath.startsWith(dir))) tree[filepath] = hash;
			}
		}

		await forEachConcurrently(scan.files, SCAN_CONCURRENCY, async (filepath) => {
			const relativePath = path.relative(root, filepath).replace(/\\/g, '/');
			try {
				const stat = await fs.stat(filepath);
				if (!stat.isFile()) return;
				if (stat.size > MAX_FILE_SIZE) {
					if (previous[relativePath]) tree[relativePath] = previous[relativePath];
					return;
				}

				const result = await blobStore.hashFile(filepath);
				tree[relativePath] = result.hash;
				if (result.content !== null && result.hash !== previous[relativePath]) {
					contents.set(relativePath, result.content);
				}
			} catch (error) {
				if (isMissingFile(error)) return;
				if (previous[relativePath]) tree[relativePath] = previous[relativePath];
			}
		});

		return { tree, contents };
	}

	// ========================================================================
	// Session Baseline
	// ========================================================================

	/** Re-take a session's tree from disk. Not queued: callers already are. */
	private async rescanBaseline(projectPath: string, sessionId: string): Promise<TreeMap | null> {
		try {
			const { tree } = await this.scanTree(projectPath, this.sessionBaselines.get(sessionId) ?? {});
			this.sessionBaselines.set(sessionId, tree);
			debug.log('snapshot', `Session baseline taken: ${Object.keys(tree).length} files for session ${sessionId}`);
			return tree;
		} catch (error) {
			debug.error('snapshot', 'Error taking session baseline:', error);
			return this.sessionBaselines.get(sessionId) ?? null;
		}
	}

	private async getSessionBaseline(
		projectPath: string,
		sessionId: string
	): Promise<TreeMap> {
		const baseline = this.sessionBaselines.get(sessionId);
		if (baseline) return baseline;
		return (await this.rescanBaseline(projectPath, sessionId)) ?? {};
	}

	// ========================================================================
	// Turn lifecycle
	// ========================================================================

	/**
	 * Start a turn: take the "before" picture this turn will be measured
	 * against.
	 *
	 * Re-taken at EVERY turn, not only the first. The tree used to be carried
	 * over from the previous capture, so everything that happened while the
	 * chat sat idle — a pull, a branch switch, the user's own edits, another
	 * chat's work — was charged to whichever turn came next, and undoing that
	 * turn reverted it.
	 *
	 * Must complete before the engine can write (the caller awaits it). Never
	 * throws: a turn without a fresh baseline still runs, it just measures
	 * against the last good one.
	 */
	async beginTurn(projectPath: string, projectId: string, sessionId: string): Promise<void> {
		await this.enqueue(sessionId, async () => {
			const worktreeId = sessionQueries.getById(sessionId)?.worktree_id ?? null;
			const startedAt = Date.now();
			const [heads] = await Promise.all([
				readRepoHeads(projectPath).catch((error) => {
					debug.warn('snapshot', 'Could not read repository HEADs:', error);
					return new Map() as RepoHeads;
				}),
				this.rescanBaseline(projectPath, sessionId)
			]);
			this.activeTurns.set(sessionId, {
				root: projectPath,
				projectId,
				worktreeId,
				scopeKey: makeScopeKey(projectId, worktreeId),
				startedAt,
				heads,
				activity: new TurnActivity(startedAt)
			});
		});
	}

	/** Feed a running turn's engine output, to learn when its tools ran. */
	observeEngineOutput(sessionId: string, output: ObservedOutput): void {
		this.activeTurns.get(sessionId)?.activity.observe(output);
	}

	/** Close a turn that will not be captured (it failed before it began). */
	async endTurn(sessionId: string): Promise<void> {
		await this.enqueue(sessionId, async () => {
			this.finishTurn(sessionId);
		});
	}

	private finishTurn(sessionId: string): void {
		const turn = this.activeTurns.get(sessionId);
		if (!turn) return;
		this.activeTurns.delete(sessionId);

		// The dirty set feeds every running turn's live indicators in this
		// workspace, so it is only cleared once none is left running.
		const othersRunning = Array.from(this.activeTurns.values()).some((t) => t.scopeKey === turn.scopeKey);
		if (!othersRunning) fileWatcher.clearDirtyFiles(turn.scopeKey);
	}

	/**
	 * Changes another chat in the same workspace can account for.
	 *
	 * Two chats running in one folder both see every write. A change is handed
	 * to the other chat when the other one already recorded the exact same
	 * result since this turn began, or when it was written while one of the
	 * other chat's tools was running and none of this turn's was. When both or
	 * neither were running, the first capture keeps it — there is nothing
	 * better to go on, and it is still counted only once.
	 *
	 * Only consulted when another chat shares the workspace; alone, a turn
	 * owns everything it sees and this costs nothing.
	 */
	private async foreignChanges(
		sessionId: string,
		turn: TurnState,
		changes: SessionScopedChanges
	): Promise<Set<string>> {
		const foreign = new Set<string>();
		const paths = Object.keys(changes);
		if (paths.length === 0) return foreign;

		const others = Array.from(this.activeTurns.entries())
			.filter(([id, other]) => id !== sessionId && other.scopeKey === turn.scopeKey)
			.map(([, other]) => other);

		const claimed = new Map<string, Set<string>>();
		for (const row of this.getScopeSnapshotsSince(turn, sessionId)) {
			if (!row.session_changes) continue;
			try {
				const settled = JSON.parse(row.session_changes) as SessionScopedChanges;
				for (const [filepath, change] of Object.entries(settled)) {
					const hashes = claimed.get(filepath) ?? new Set<string>();
					hashes.add(change.newHash);
					claimed.set(filepath, hashes);
				}
			} catch { /* skip malformed */ }
		}

		for (const filepath of paths) {
			if (claimed.get(filepath)?.has(changes[filepath].newHash)) {
				foreign.add(filepath);
				continue;
			}
			if (others.length === 0) continue;

			const writtenAt = await this.changeTime(turn, filepath, changes[filepath]);
			if (writtenAt === undefined) continue;
			const mine = turn.activity.wasRunningAt(writtenAt);
			const theirs = others.some((other) => other.activity.wasRunningAt(writtenAt));
			if (theirs && !mine) foreign.add(filepath);
		}
		return foreign;
	}

	/**
	 * When a change happened (epoch ms), or undefined when nothing says.
	 *
	 * A file still on disk carries its modification time. A deleted one does
	 * not, so the watcher's record of the event is used, and failing that the
	 * nearest surviving directory's mtime — removing an entry updates it.
	 */
	private async changeTime(
		turn: TurnState,
		filepath: string,
		change: SessionScopedChanges[string]
	): Promise<number | undefined> {
		if (change.newHash) {
			try {
				return (await fs.stat(path.join(turn.root, filepath))).mtimeMs;
			} catch {
				return undefined;
			}
		}

		const seen = fileWatcher.getLastChangeAt(turn.scopeKey, filepath);
		if (seen !== undefined) return seen;

		let dir = path.dirname(filepath);
		while (true) {
			try {
				return (await fs.stat(path.join(turn.root, dir === '.' ? '' : dir))).mtimeMs;
			} catch {
				if (dir === '.' || dir === '') return undefined;
				dir = path.dirname(dir);
			}
		}
	}

	/** Other chats' snapshots in the same workspace, captured since `turn` began. */
	private getScopeSnapshotsSince(turn: TurnState, sessionId: string): Array<{ session_changes: string | null }> {
		const db = getDatabase();
		return db.prepare(`
			SELECT s.session_changes FROM message_snapshots s
			JOIN chat_sessions c ON c.id = s.session_id
			WHERE s.project_id = ? AND s.session_id != ? AND s.created_at >= ?
				AND (s.is_deleted IS NULL OR s.is_deleted = 0)
				AND COALESCE(c.worktree_id, '') = ?
		`).all(
			turn.projectId,
			sessionId,
			new Date(turn.startedAt).toISOString(),
			turn.worktreeId ?? ''
		) as Array<{ session_changes: string | null }>;
	}

	// ========================================================================
	// In-flight turn
	// ========================================================================

	/**
	 * The hash a file had when the running turn started.
	 *
	 * `known: false` means this session has no baseline at all, which is not the
	 * same as "the file is new" — the caller must not read an absent baseline as
	 * an empty file, or every file in the project would look freshly created.
	 */
	getBaselineHash(sessionId: string, relativePath: string): { known: boolean; hash: string } {
		const baseline = this.sessionBaselines.get(sessionId);
		if (!baseline) return { known: false, hash: '' };
		return { known: true, hash: baseline[relativePath] || '' };
	}

	/**
	 * Changes made since the turn began, for a turn that is still running.
	 *
	 * The settled source of truth is `captureSnapshot`, but it only lands when
	 * the stream ends — and the AI-change indicators have to light up while the
	 * model is still working. This answers the same question early, from the
	 * same baseline, without writing anything: no snapshot row, no baseline
	 * move, no dirty-set clear. Whatever it reports is replaced wholesale by the
	 * real capture a moment later, which also applies the git attribution this
	 * cheaper read skips.
	 *
	 * Candidates come from the file watcher's dirty set, so the cost is
	 * proportional to what actually changed rather than to repository size. The
	 * watcher only runs while a client is watching the project — which is
	 * exactly when a panel that renders these indicators is mounted — and any
	 * event it missed is recovered by the full scan at turn end.
	 */
	async getPendingChanges(
		projectPath: string,
		scopeKey: string,
		sessionId: string
	): Promise<SessionScopedChanges> {
		// No running turn, or no baseline for it: nothing this chat is doing now.
		// Building a baseline here would hash the mid-turn disk state and declare
		// it unchanged, blinding the indicators for the whole turn — so decline.
		const turn = this.activeTurns.get(sessionId);
		const baseline = this.sessionBaselines.get(sessionId);
		if (!turn || !baseline) return {};

		const dirty = fileWatcher.getDirtyFiles(scopeKey);
		if (dirty.size === 0) return {};

		// A path already in the baseline passed the gitignore-aware scan once, so
		// it needs no second opinion. Only genuinely new paths do, and only those
		// make us pay for a scan.
		let eligible: Set<string> | null = null;
		const hasNewPaths = Array.from(dirty).some((relativePath) => !(relativePath in baseline));
		if (hasNewPaths) {
			try {
				const { files } = await scanSnapshotFiles(projectPath, { pruneGenerated: true });
				eligible = new Set(
					files.map((filepath) => path.relative(projectPath, filepath).replace(/\\/g, '/'))
				);
			} catch (error) {
				debug.warn('snapshot', 'Pending-change scan failed, reporting tracked files only:', error);
			}
		}

		const changes: SessionScopedChanges = {};

		for (const relativePath of dirty) {
			// An unknown path is only reported once the scan has vouched for it —
			// so a build artifact or an ignored temp file never becomes a dot.
			const oldHash = baseline[relativePath] || '';
			if (!oldHash && !eligible?.has(relativePath)) continue;

			const fullPath = path.join(projectPath, relativePath);
			try {
				const stat = await fs.stat(fullPath);
				if (stat.size > MAX_FILE_SIZE) continue;

				const result = await blobStore.hashFile(fullPath);
				if (result.hash !== oldHash) {
					changes[relativePath] = { oldHash, newHash: result.hash };
				}
			} catch (error) {
				// Gone from disk: a deletion when we knew the file, nothing otherwise
				// (a temp file the turn created and removed again). Unreadable is
				// not gone.
				if (oldHash && isMissingFile(error)) changes[relativePath] = { oldHash, newHash: '' };
			}
		}

		for (const filepath of await this.foreignChanges(sessionId, turn, changes)) {
			delete changes[filepath];
		}

		return changes;
	}

	// ========================================================================
	// Snapshot Capture
	// ========================================================================

	/**
	 * Capture the end of a turn: what changed on disk since it began, minus
	 * what git and other chats account for. Closes the turn.
	 */
	captureSnapshot(
		projectPath: string,
		projectId: string,
		sessionId: string,
		messageId: string
	): Promise<MessageSnapshot> {
		return this.enqueue(sessionId, async () => {
			try {
				return await this.captureTurn(projectPath, projectId, sessionId, messageId);
			} finally {
				this.finishTurn(sessionId);
			}
		});
	}

	private async captureTurn(
		projectPath: string,
		projectId: string,
		sessionId: string,
		messageId: string
	): Promise<MessageSnapshot> {
		try {
			const previousSnapshots = snapshotQueries.getBySessionId(sessionId);
			const previousSnapshot = previousSnapshots.length > 0
				? previousSnapshots[previousSnapshots.length - 1]
				: null;

			// The disk at the start of this turn.
			const previousTree = await this.getSessionBaseline(projectPath, sessionId);

			// The source of truth is the DISK, not the file watcher's dirty set. The
			// watcher only runs while the Files/Git panel is mounted, so relying on it
			// silently dropped snapshots whenever the user chatted with those panels
			// closed. A gitignore-aware scan + hash diff against the baseline is
			// always correct, and blobStore.hashFile's mtime+size cache keeps it
			// cheap — only files that actually changed are re-read.
			const { tree: currentTree, contents: readContents } = await this.scanTree(projectPath, previousTree);
			const sessionChanges = diffTrees(previousTree, currentTree);

			// A disk diff sees every writer. Take out what is not this turn's.
			const turn = this.activeTurns.get(sessionId);
			if (turn && Object.keys(sessionChanges).length > 0) {
				const git = await attributeGitChanges(projectPath, turn.heads, turn.startedAt, sessionChanges);
				for (const filepath of git.explained) delete sessionChanges[filepath];
				for (const [filepath, oldHash] of git.rebased) {
					if (oldHash === sessionChanges[filepath].newHash) delete sessionChanges[filepath];
					else sessionChanges[filepath].oldHash = oldHash;
				}

				for (const filepath of await this.foreignChanges(sessionId, turn, sessionChanges)) {
					delete sessionChanges[filepath];
				}

				if (git.explained.size > 0 || git.rebased.size > 0) {
					debug.log('snapshot', `Git accounts for ${git.explained.size} file(s), ${git.rebased.size} re-based`);
				}
			}

			// The next turn re-takes its own baseline; this keeps getBaselineHash
			// honest in between, and is the tree a restore compares against.
			this.sessionBaselines.set(sessionId, currentTree);

			// No changes vs the baseline → reuse the existing head snapshot.
			if (Object.keys(sessionChanges).length === 0 && previousSnapshot) {
				debug.log('snapshot', 'No file changes detected (full scan), skipping snapshot');
				return previousSnapshot;
			}

			// Calculate line-level file change stats
			const fileStats = await this.calculateChangeStats(sessionChanges, readContents);

			const metadata: SnapshotMetadata = {
				totalFiles: Object.keys(currentTree).length,
				totalSize: 0,
				capturedAt: new Date().toISOString(),
				snapshotType: 'delta',
				deltaSize: Object.keys(sessionChanges).length,
				storageFormat: 'blob-store'
			};

			const snapshotId = `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

		// Filter out files already in expected state on disk (no actual change needed),
		// and remember the current on-disk hash of the files that WOULD change so the
		// local-drift pass below can run without re-reading them.
		const currentHashByFile = new Map<string, string>();
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
				} else {
					currentHashByFile.set(filepath, currentHash);
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
		// Only chats working on the same copy of the project can conflict: a
		// worktree session edits its own files, however alike the paths look.
		const worktreeId = sessionQueries.getById(sessionId)?.worktree_id ?? null;
		const allProjectSnapshots = this.getAllProjectSnapshots(projectId, worktreeId);

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

		// Local-drift detection: a file restore would overwrite/delete whose CURRENT
		// on-disk content was never captured by this session's snapshots. Overwriting
		// it would lose an unrecoverable manual edit, so surface it as a conflict and
		// let the user decide. Normal undo/redo never trips this — the working tree's
		// content there always maps to a captured oldHash/newHash.
		if (projectPath) {
			const sessionReferenced = snapshotQueries.collectBlobHashes(sessionSnapshots);
			const alreadyFlagged = new Set(uniqueConflicts.map(c => c.filepath));
			for (const [filepath] of expectedState) {
				if (alreadyFlagged.has(filepath)) continue;
				const currentHash = currentHashByFile.get(filepath) || '';
				if (!currentHash) continue; // no file on disk → nothing to lose
				if (!sessionReferenced.has(currentHash)) {
					uniqueConflicts.push({
						filepath,
						modifiedBySessionId: sessionId,
						modifiedBySnapshotId: '',
						modifiedAt: '',
						reason: 'local'
					});
				}
			}
		}

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

	private getAllProjectSnapshots(projectId: string, worktreeId: string | null): MessageSnapshot[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT s.* FROM message_snapshots s
			JOIN chat_sessions c ON c.id = s.session_id
			WHERE s.project_id = ? AND (s.is_deleted IS NULL OR s.is_deleted = 0)
				AND COALESCE(c.worktree_id, '') = ?
			ORDER BY s.created_at ASC
		`).all(projectId, worktreeId ?? '') as MessageSnapshot[];
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
	restoreSessionScoped(
		projectPath: string,
		sessionId: string,
		targetCheckpointMessageId: string | null,
		conflictResolutions?: ConflictResolution,
		targetPath?: string[]
	): Promise<{ restoredFiles: number; skippedFiles: number }> {
		// Queued with the session's captures: a restore rewrites the tree a
		// capture still scanning would otherwise record as the turn's work.
		return this.enqueue(sessionId, () => this.restoreNow(
			projectPath, sessionId, targetCheckpointMessageId, conflictResolutions, targetPath
		));
	}

	private async restoreNow(
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

			// Re-take the baseline from actual disk state: files already at their
			// expected state were skipped, and after a server restart there is no
			// baseline at all. A partial one would compute oldHash='' for every
			// file it misses, and a later restore would delete those files.
			await this.rescanBaseline(projectPath, sessionId);

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
		this.activeTurns.delete(sessionId);
	}
}

// Export singleton instance
export const snapshotService = SnapshotService.getInstance();
