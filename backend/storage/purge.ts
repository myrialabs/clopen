/**
 * Deleting chats — the one path every deletion goes through.
 *
 * Deleting one chat, deleting all of a project's chats, deleting a project, and
 * Storage's "delete old chats" used to be three copies of the same steps, and
 * each had drifted: none removed the engine's own transcript of the chat, and
 * the project path forgot the memory-extraction bookkeeping. They all call this
 * now, so a chat leaves nothing behind whichever way it goes.
 *
 * Order matters:
 *   1. stop the chat's streams, so nothing writes while it is torn down
 *   2. collect the snapshot blobs and engine sessions the chat refers to
 *   3. delete the rows
 *   4. delete blobs nothing else refers to
 *   5. delete engine transcripts nothing else refers to — in the background,
 *      because deciding "nothing else" needs a current index of every chat,
 *      and building that the first time takes as long as reading the whole
 *      message table. The deletion is finished from the user's point of view
 *      after step 4.
 */

import { sessionQueries, snapshotQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { snapshotService } from '$backend/snapshot/snapshot-service';
import { blobStore } from '$backend/snapshot/blob-store';
import { cancelEpisodicIngest } from '$backend/memory/extract';
import { forgetSessionContext } from '$backend/memory/context';
import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { collectEngineRefs, ensureFreshSessionIndex, measureSession, type EngineRef } from './session-index';
import { listAllTranscripts, transcriptStoreFor } from './transcripts';
import { pruneTranscriptAliases } from './transcripts/aliases';
import { recordCleanupRun } from './history';

export interface PurgeResult {
	deletedIds: string[];
	freedBlobs: number;
}

/**
 * Delete chats and everything that exists only because of them.
 * `wholeProject` deletes every chat of that project in one statement set.
 */
export async function purgeSessions(
	sessionIds: string[],
	options: { wholeProject?: string } = {}
): Promise<PurgeResult> {
	const ids = options.wholeProject
		? sessionQueries.getByProjectId(options.wholeProject).map(session => session.id)
		: sessionIds.filter(id => sessionQueries.getById(id));
	if (ids.length === 0) return { deletedIds: [], freedBlobs: 0 };

	await Promise.all(ids.map(id => streamManager.cleanupSessionStreams(id).catch(error => {
		debug.warn('session', `Stream cleanup error for session ${id}:`, error);
	})));

	const hashes = new Set<string>();
	const refs: EngineRef[] = [];
	for (const id of ids) {
		for (const hash of snapshotService.getSessionBaselineHashes(id)) hashes.add(hash);
		for (const hash of snapshotQueries.collectBlobHashes(snapshotQueries.getAllBySessionId(id))) hashes.add(hash);
		try {
			refs.push(...measureSession(id).refs);
		} catch (error) {
			debug.warn('storage', `Could not read engine references of ${id}:`, error);
		}
		snapshotService.clearSessionBaseline(id);
		cancelEpisodicIngest(id);
		forgetSessionContext(id);
	}

	const deletedIds = options.wholeProject
		? sessionQueries.deleteAllByProjectId(options.wholeProject)
		: (ids.forEach(id => sessionQueries.delete(id)), ids);

	const freedBlobs = await collectOrphanBlobs(hashes);
	if (refs.length > 0) void releaseTranscripts(refs);

	return { deletedIds, freedBlobs };
}

/** Delete those of `candidates` that no snapshot row and no live baseline uses. */
export async function collectOrphanBlobs(candidates: Set<string>): Promise<number> {
	if (candidates.size === 0) return 0;
	const referencedByDb = snapshotQueries.getAllReferencedBlobHashes();
	const referencedByMemory = snapshotService.getAllBaselineHashes();
	const orphaned = [...candidates].filter(hash => !referencedByDb.has(hash) && !referencedByMemory.has(hash));
	if (orphaned.length === 0) return 0;
	const deleted = await blobStore.deleteBlobs(orphaned);
	debug.log('snapshot', `Cleaned up ${deleted}/${orphaned.length} orphaned blobs`);
	return deleted;
}

/**
 * Remove the engine transcripts of deleted chats that no remaining chat refers
 * to. Runs after the deletion has returned; a failure here only leaves files the
 * orphan cleanup will find later.
 */
export async function releaseTranscripts(refs: EngineRef[]): Promise<number> {
	const startedAt = new Date().toISOString();
	try {
		await ensureFreshSessionIndex(activeChatIds());
		const { byEngine } = collectEngineRefs();
		const active = activeEngineSessionIds();
		const release = new Map<EngineType, Set<string>>();
		for (const ref of refs) {
			if (byEngine.get(ref.engine)?.has(ref.id) || active.has(ref.id)) continue;
			let set = release.get(ref.engine);
			if (!set) release.set(ref.engine, set = new Set());
			set.add(ref.id);
		}
		if (release.size === 0) return 0;

		const entries = await listAllTranscripts();
		let freed = 0;
		let removed = 0;
		for (const [engine, set] of release) {
			const store = transcriptStoreFor(engine);
			if (!store) continue;
			const result = await store.remove(entries.filter(entry => entry.engine === engine && set.has(entry.id)));
			freed += result.freedBytes;
			removed += result.removed;
			for (const error of result.errors) debug.warn('storage', `Transcript removal: ${error}`);
		}
		pruneTranscriptAliases('claude-code', new Set(byEngine.get('claude-code') ?? []));
		if (removed > 0) {
			recordCleanupRun({
				action: 'orphan-transcripts', trigger: 'delete', startedAt,
				finishedAt: new Date().toISOString(), freedBytes: freed, items: removed, error: null
			});
		}
		return freed;
	} catch (error) {
		debug.warn('storage', 'Could not release engine transcripts of deleted chats:', error);
		return 0;
	}
}

/** Engine session ids a running stream is reading from or writing to. */
export function activeEngineSessionIds(): Set<string> {
	const ids = new Set<string>();
	for (const stream of streamManager.getAllStreams()) {
		if (stream.status !== 'active') continue;
		if (stream.sdkSessionId) ids.add(stream.sdkSessionId);
		if (stream.preStreamSessionId) ids.add(stream.preStreamSessionId);
		if (stream.resumeTargetSessionId) ids.add(stream.resumeTargetSessionId);
	}
	return ids;
}

/** Chats with a running stream. Nothing of theirs is touched by a cleanup. */
export function activeChatIds(): Set<string> {
	const ids = new Set<string>();
	for (const stream of streamManager.getAllStreams()) {
		if (stream.status === 'active') ids.add(stream.chatSessionId);
	}
	return ids;
}
