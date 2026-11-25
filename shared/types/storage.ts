/**
 * Settings → Storage: what Clopen keeps on disk, and what can be removed.
 *
 * One report answers both questions. The scanner measures every category once,
 * attributes what it can to a project, and prices every cleanup at the same
 * time, so the numbers a cleanup promises are the numbers the report shows.
 */

import type { EngineType } from './unified';

export type StorageCategoryId =
	| 'chats'
	| 'engine-transcripts'
	| 'engine-caches'
	| 'snapshots'
	| 'worktrees'
	| 'preview-profiles'
	| 'stack'
	| 'other';

export interface StorageCategory {
	id: StorageCategoryId;
	bytes: number;
	/** Bytes the safe cleanups would free from this category right now. */
	reclaimableBytes: number;
}

/** Clopen data attributable to one project. */
export interface StorageProjectBreakdown {
	chats: number;
	engineTranscripts: number;
	snapshots: number;
	worktrees: number;
	previewProfiles: number;
}

export interface StorageProjectEntry {
	projectId: string;
	name: string;
	path: string;
	/** Sum of `breakdown` — Clopen's data for this project, not the project folder. */
	bytes: number;
	breakdown: StorageProjectBreakdown;
	sessionCount: number;
	slimmedSessionCount: number;
	worktreeCount: number;
	lastActivityAt: string | null;
}

export interface StorageEngineEntry {
	engine: EngineType;
	/** Session transcripts and stores. */
	transcriptBytes: number;
	transcriptCount: number;
	/** Transcripts no chat in Clopen refers to any more. */
	orphanBytes: number;
	orphanCount: number;
	/** Transcripts fully contained in a later one (Claude forks). */
	redundantBytes: number;
	redundantCount: number;
	/** Everything else under the engine's home: tool caches, logs, plugins, config. */
	otherBytes: number;
}

export type CleanupActionId =
	| 'orphan-transcripts'
	| 'dedupe-transcripts'
	| 'orphan-snapshots'
	| 'orphan-profiles'
	| 'orphan-worktree-dirs'
	| 'legacy-engine-data'
	| 'browser-cache'
	| 'tool-caches'
	| 'engine-logs'
	| 'compact-database'
	| 'stale-worktrees'
	| 'project-profiles'
	| 'slim-old-chats'
	| 'delete-old-chats';

/**
 * - `safe`        — nothing anyone uses: leftovers, duplicates, caches.
 * - `caution`     — removes something in use that comes back on its own, at a
 *                   cost (a sign-in, a download, a short pause).
 * - `destructive` — removes something that does not come back.
 */
export type CleanupTier = 'safe' | 'caution' | 'destructive';

export interface CleanupActionMeta {
	id: CleanupActionId;
	tier: CleanupTier;
	/** Takes an age threshold in days. */
	usesAge: boolean;
	/** Can be narrowed to one project. */
	projectScoped: boolean;
	/** Can run on a schedule. */
	automatable: boolean;
}

export interface CleanupEstimate {
	action: CleanupActionId;
	bytes: number;
	items: number;
}

export interface CleanupRequest {
	action: CleanupActionId;
	projectId?: string | null;
	olderThanDays?: number;
}

export interface CleanupResult {
	action: CleanupActionId;
	freedBytes: number;
	items: number;
	errors: string[];
	/** Set when the action did nothing because something was in use. */
	skippedReason?: string;
}

export interface StorageReport {
	generatedAt: string;
	durationMs: number;
	dataDir: string;
	totalBytes: number;
	/** The volume the data directory lives on. Null where it cannot be read. */
	disk: { totalBytes: number; freeBytes: number } | null;
	categories: StorageCategory[];
	projects: StorageProjectEntry[];
	/** Clopen data no project owns: caches, Stack, the database's own overhead. */
	unattributedBytes: number;
	engines: StorageEngineEntry[];
	/** Priced at scan time for every action that needs no parameters. */
	estimates: CleanupEstimate[];
	database: {
		fileBytes: number;
		/** Pages SQLite holds free inside the file; VACUUM returns them to the disk. */
		freeBytes: number;
		incrementalVacuum: boolean;
	};
}

export interface StorageScanStatus {
	scanning: boolean;
	phase: string | null;
	/** 0..1, null when the phase cannot tell. */
	progress: number | null;
	startedAt: string | null;
	error: string | null;
}

export interface StoragePolicyAction {
	enabled: boolean;
	olderThanDays?: number;
}

export interface StoragePolicy {
	/** Master switch for scheduled cleanup. */
	enabled: boolean;
	/** Hours between scheduled runs. */
	intervalHours: number;
	actions: Partial<Record<CleanupActionId, StoragePolicyAction>>;
	lastRunAt: string | null;
}

export interface StorageCleanupRun {
	id: number;
	action: CleanupActionId;
	trigger: 'manual' | 'auto' | 'delete';
	startedAt: string;
	finishedAt: string | null;
	freedBytes: number;
	items: number;
	error: string | null;
}
