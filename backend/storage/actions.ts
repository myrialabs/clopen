/**
 * Cleanup actions. Each one re-reads what it is about to delete at the moment it
 * runs — a report is only an estimate, and the files may have changed since —
 * and every action applies the same protections as the scan that priced it:
 * nothing a running stream uses, nothing touched within the grace period,
 * nothing a chat or workspace still refers to.
 *
 * One cleanup runs at a time.
 */

import type {
	CleanupActionId, CleanupActionMeta, CleanupEstimate, CleanupRequest, CleanupResult
} from '$shared/types/storage';
import { debug } from '$shared/utils/logger';
import { selectOldChats, slimSession, estimateSlimBytes } from './chats';
import { compactDatabase, databaseStats, releaseFreePagesIfCheap } from './database';
import { legacyEnginePaths, removePaths, staleLogFiles, toolCachePaths } from './engine-homes';
import { ws } from '$backend/utils/ws';
import { recordCleanupRun } from './history';
import { clearProfileCaches, listProfileDirs, orphanProfiles, removeProfileDirs, wipeProjectProfiles } from './preview-profiles';
import { activeChatIds, purgeSessions } from './purge';
import { currentTranscriptUsage, getLastStorageReport, scanStorage } from './scanner';
import { refreshSessionIndex } from './session-index';
import { blobSizes, deleteBlobs, orphanBlobs } from './snapshots';
import { applyDedupe, listAllTranscripts, removeOrphans, selectOrphans, selectRedundant } from './transcripts';
import { listWorktreeDirs, orphanWorktreeDirs, removeWorktreeDirs, removeWorktrees, staleWorktrees } from './worktrees';
import { getDatabase } from '$backend/database';
import { measurePath } from './fs-size';
import { profileDirName, profilesRoot } from '$backend/preview/browser/browser-pool';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import { worktreeQueries } from '$backend/database/queries';
import { join } from 'node:path';

export const CLEANUP_ACTIONS: CleanupActionMeta[] = [
	{ id: 'orphan-transcripts', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'dedupe-transcripts', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'orphan-snapshots', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'orphan-profiles', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'orphan-worktree-dirs', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'legacy-engine-data', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'engine-logs', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'browser-cache', tier: 'safe', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'tool-caches', tier: 'caution', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'compact-database', tier: 'caution', usesAge: false, projectScoped: false, automatable: true },
	{ id: 'stale-worktrees', tier: 'caution', usesAge: true, projectScoped: true, automatable: true },
	{ id: 'project-profiles', tier: 'caution', usesAge: false, projectScoped: true, automatable: false },
	{ id: 'slim-old-chats', tier: 'destructive', usesAge: true, projectScoped: true, automatable: true },
	{ id: 'delete-old-chats', tier: 'destructive', usesAge: true, projectScoped: true, automatable: true }
];

export function cleanupMeta(action: CleanupActionId): CleanupActionMeta {
	const meta = CLEANUP_ACTIONS.find(item => item.id === action);
	if (!meta) throw new Error(`Unknown cleanup action: ${action}`);
	return meta;
}

const DEFAULT_AGE_DAYS = 90;
const isStreaming = () => activeChatIds().size > 0;

function activeWorktreeIds(): Set<string> {
	const active = activeChatIds();
	const ids = new Set<string>();
	if (active.size === 0) return ids;
	const rows = getDatabase().prepare('SELECT id, worktree_id FROM chat_sessions WHERE worktree_id IS NOT NULL')
		.all() as { id: string; worktree_id: string }[];
	for (const row of rows) if (active.has(row.id)) ids.add(row.worktree_id);
	return ids;
}

/** Price an action. Parameterless actions answer from the last report when there is one. */
export async function estimateCleanup(request: CleanupRequest): Promise<CleanupEstimate> {
	const { action } = request;
	const days = request.olderThanDays ?? DEFAULT_AGE_DAYS;
	const meta = cleanupMeta(action);

	if (!meta.usesAge && !meta.projectScoped) {
		const cached = getLastStorageReport()?.estimates.find(estimate => estimate.action === action);
		if (cached) return cached;
	}

	switch (action) {
		case 'slim-old-chats':
		case 'delete-old-chats': {
			await refreshSessionIndex();
			const chats = selectOldChats({
				olderThanDays: days,
				projectId: request.projectId,
				excludeSlimmed: action === 'slim-old-chats',
				active: activeChatIds()
			});
			const bytes = chats.reduce((total, chat) => total + chat.bytes, 0);
			return { action, bytes: action === 'slim-old-chats' ? estimateSlimBytes(bytes) : bytes, items: chats.length };
		}
		case 'stale-worktrees': {
			const stale = await staleWorktrees(await listWorktreeDirs(), {
				olderThanDays: days, projectId: request.projectId, activeChatWorktrees: activeWorktreeIds()
			});
			return { action, bytes: stale.reduce((total, dir) => total + dir.bytes, 0), items: stale.length };
		}
		case 'project-profiles': {
			if (!request.projectId) return { action, bytes: 0, items: 0 };
			const keys = [makeScopeKey(request.projectId), ...worktreeQueries.getByProjectId(request.projectId).map(w => makeScopeKey(request.projectId!, w.id))];
			let bytes = 0;
			let items = 0;
			for (const key of keys) {
				const size = (await measurePath(join(profilesRoot(), profileDirName(key)))).bytes;
				if (size > 0) items++;
				bytes += size;
			}
			return { action, bytes, items };
		}
		default: {
			const report = await scanStorage();
			return report.estimates.find(estimate => estimate.action === action) ?? { action, bytes: 0, items: 0 };
		}
	}
}

let running: CleanupActionId | null = null;

export function runningCleanup(): CleanupActionId | null {
	return running;
}

/** Run one action now. Records the outcome in the cleanup history. */
export async function runCleanup(request: CleanupRequest, trigger: 'manual' | 'auto'): Promise<CleanupResult> {
	if (running) throw new Error('Another cleanup is running. Try again when it finishes.');
	running = request.action;
	const startedAt = new Date().toISOString();
	let result: CleanupResult = { action: request.action, freedBytes: 0, items: 0, errors: [] };
	try {
		result = await perform(request);
	} catch (error) {
		result.errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		running = null;
	}

	recordCleanupRun({
		action: request.action,
		trigger,
		startedAt,
		finishedAt: new Date().toISOString(),
		freedBytes: result.freedBytes,
		items: result.items,
		error: result.errors.length > 0 ? result.errors.slice(0, 3).join('; ') : (result.skippedReason ?? null)
	});
	debug.log('storage', `Cleanup ${request.action} (${trigger}): ${result.items} item(s), ${result.freedBytes} bytes`);
	return result;
}

async function perform(request: CleanupRequest): Promise<CleanupResult> {
	const { action } = request;
	const days = request.olderThanDays ?? DEFAULT_AGE_DAYS;
	const done = (freedBytes: number, items: number, errors: string[] = []): CleanupResult => ({ action, freedBytes, items, errors });
	const skipped = (reason: string): CleanupResult => ({ action, freedBytes: 0, items: 0, errors: [], skippedReason: reason });

	switch (action) {
		case 'orphan-transcripts': {
			const usage = await currentTranscriptUsage({ strict: true });
			const orphans = selectOrphans(await listAllTranscripts(), usage);
			const result = await removeOrphans(orphans, usage);
			return done(result.freedBytes, result.removed, result.errors);
		}
		case 'dedupe-transcripts': {
			const usage = await currentTranscriptUsage({ strict: true });
			const redundant = await selectRedundant(await listAllTranscripts(), usage);
			const result = await applyDedupe(redundant);
			return done(result.freedBytes, result.removed, result.errors);
		}
		case 'orphan-snapshots': {
			if (isStreaming()) return skipped('A chat is running; checkpoints are left alone until it finishes.');
			const { hashes, bytes } = orphanBlobs(await blobSizes());
			// Re-checked between batches: a turn that starts mid-sweep writes and
			// reuses blobs, and a blob it reuses must not be deleted under it.
			let deleted = 0;
			for (let i = 0; i < hashes.length; i += 500) {
				if (isStreaming()) break;
				deleted += await deleteBlobs(hashes.slice(i, i + 500));
			}
			return done(deleted === hashes.length ? bytes : Math.round(bytes * (deleted / Math.max(1, hashes.length))), deleted);
		}
		case 'orphan-profiles': {
			const result = await removeProfileDirs(orphanProfiles(await listProfileDirs()));
			return done(result.freedBytes, result.removed);
		}
		case 'orphan-worktree-dirs': {
			const result = await removeWorktreeDirs(orphanWorktreeDirs(await listWorktreeDirs()));
			return done(result.freedBytes, result.removed);
		}
		case 'legacy-engine-data': {
			const result = await removePaths(await legacyEnginePaths());
			return done(result.freedBytes, result.removed, result.errors);
		}
		case 'engine-logs': {
			const result = await removePaths((await staleLogFiles()).map(file => file.path));
			return done(result.freedBytes, result.removed, result.errors);
		}
		case 'browser-cache': {
			const result = await clearProfileCaches((await listProfileDirs()).filter(dir => dir.scope));
			return {
				...done(result.freedBytes, result.cleared),
				...(result.skipped > 0 && { skippedReason: `${result.skipped} profile(s) in use were left alone.` })
			};
		}
		case 'tool-caches': {
			if (isStreaming()) return skipped('A chat is running and may be using these caches.');
			const paths = await toolCachePaths();
			const result = await removePaths(paths);
			return done(result.freedBytes, result.removed, result.errors);
		}
		case 'compact-database': {
			if (databaseStats().freeBytes === 0) return done(0, 0);
			const result = await compactDatabase(isStreaming);
			return done(result.freedBytes, 1);
		}
		case 'stale-worktrees': {
			const stale = await staleWorktrees(await listWorktreeDirs(), {
				olderThanDays: days, projectId: request.projectId, activeChatWorktrees: activeWorktreeIds()
			});
			const result = await removeWorktrees(stale);
			return done(result.freedBytes, result.removed);
		}
		case 'project-profiles': {
			if (!request.projectId) return skipped('No project given.');
			return done(await wipeProjectProfiles(request.projectId), 1);
		}
		case 'slim-old-chats': {
			await refreshSessionIndex();
			const chats = selectOldChats({ olderThanDays: days, projectId: request.projectId, excludeSlimmed: true, active: activeChatIds() });
			let freed = 0;
			let items = 0;
			const errors: string[] = [];
			for (const chat of chats) {
				if (activeChatIds().has(chat.id)) continue;
				try {
					freed += (await slimSession(chat.id)).freedBytes;
					items++;
				} catch (error) {
					errors.push(`${chat.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			freed = Math.max(freed, await releaseFreePagesIfCheap(isStreaming));
			return done(freed, items, errors);
		}
		case 'delete-old-chats': {
			await refreshSessionIndex();
			const chats = selectOldChats({ olderThanDays: days, projectId: request.projectId, active: activeChatIds() });
			const bytes = chats.reduce((total, chat) => total + chat.bytes, 0);
			const { deletedIds } = await purgeSessions(chats.map(chat => chat.id));
			const projectOf = new Map(chats.map(chat => [chat.id, chat.projectId]));
			for (const sessionId of deletedIds) {
				const projectId = projectOf.get(sessionId);
				if (projectId) ws.emit.project(projectId, 'sessions:session-deleted', { sessionId, projectId });
			}
			await releaseFreePagesIfCheap(isStreaming);
			return done(bytes, deletedIds.length);
		}
	}
}
