/**
 * Engine transcript stores, and the two questions asked of them all: which
 * transcripts no chat uses (orphans), and which are copies of another (Claude
 * forks). Cline keeps its sessions in memory only, so it has no store here.
 */

import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { claudeTranscripts } from './claude';
import { cursorTranscripts } from './cursor';
import { codexTranscripts, copilotTranscripts, piTranscripts, qwenTranscripts } from './file-stores';
import { openCodeTranscripts } from './opencode';
import { findContained, groupByOwner, readChain, type ChainSummary, type RedundantTranscript } from './claude-dedupe';
import { pruneTranscriptAliases, recordTranscriptAlias, transcriptAliasTargets } from './aliases';
import type { TranscriptEntry, TranscriptRemoval, TranscriptStore } from './types';

export type { TranscriptEntry, TranscriptRemoval, TranscriptStore } from './types';
export { resolveTranscriptAlias } from './aliases';

export const transcriptStores: TranscriptStore[] = [
	claudeTranscripts,
	codexTranscripts,
	qwenTranscripts,
	copilotTranscripts,
	piTranscripts,
	cursorTranscripts,
	openCodeTranscripts
];

export function transcriptStoreFor(engine: EngineType): TranscriptStore | null {
	return transcriptStores.find(store => store.engine === engine) ?? null;
}

/**
 * Whether a resume target still exists. Engines without a store (Cline) and any
 * failure to check answer true: the caller falls back to replaying the chat when
 * this says false, so a false negative would cost a needlessly long prompt.
 */
export async function transcriptExists(engine: EngineType, id: string, projectPath: string): Promise<boolean> {
	const store = transcriptStoreFor(engine);
	if (!store) return true;
	try {
		return await store.exists(id, projectPath);
	} catch (error) {
		debug.warn('storage', `Could not check ${engine} transcript ${id}:`, error);
		return true;
	}
}

/**
 * Transcripts touched this recently are never treated as unused. The engine
 * writes a new session's file before Clopen has saved the first message that
 * names it, and a parked turn can sit idle for a long time.
 */
export const TRANSCRIPT_GRACE_MS = 6 * 60 * 60_000;

export interface TranscriptUsage {
	/** Engine session ids chats refer to, per engine. */
	refs: Map<EngineType, Set<string>>;
	/** For each engine session id, the chats that refer to it. */
	owners: Map<string, Set<string>>;
	/** Engine session ids a running stream is using. */
	active: Set<string>;
}

function referencedFor(engine: EngineType, usage: TranscriptUsage): Set<string> {
	const referenced = new Set(usage.refs.get(engine) ?? []);
	for (const id of usage.active) referenced.add(id);
	for (const id of transcriptAliasTargets(engine)) referenced.add(id);
	return referenced;
}

/** Transcripts no chat refers to. */
export function selectOrphans(entries: TranscriptEntry[], usage: TranscriptUsage, now = Date.now()): TranscriptEntry[] {
	const byEngine = new Map<EngineType, TranscriptEntry[]>();
	for (const entry of entries) {
		let list = byEngine.get(entry.engine);
		if (!list) byEngine.set(entry.engine, list = []);
		list.push(entry);
	}

	const orphans: TranscriptEntry[] = [];
	for (const [engine, list] of byEngine) {
		const referenced = referencedFor(engine, usage);
		const kept = new Set(list.filter(entry =>
			referenced.has(entry.id) || now - entry.mtimeMs < TRANSCRIPT_GRACE_MS
		).map(entry => entry.id));

		// A session's parent goes with it in Open Code (subagent sessions hang off
		// the session that spawned them), so anything above a kept one is kept.
		const byId = new Map(list.map(entry => [entry.id, entry]));
		for (const id of [...kept]) {
			let parent = byId.get(id)?.parentId;
			for (let hops = 0; parent && hops < 64; hops++) {
				kept.add(parent);
				parent = byId.get(parent)?.parentId;
			}
		}

		for (const entry of list) if (!kept.has(entry.id)) orphans.push(entry);
	}
	return orphans;
}

// ── Claude fork deduplication ───────────────────────────────────────────────

/**
 * Per-file chain summaries are large (every entry uuid), so they are not kept;
 * what is kept is the VERDICT for a group, keyed by the exact files in it. A
 * rescan re-reads only groups that gained or changed a file.
 */
const verdictCache = new Map<string, RedundantTranscript[]>();

function groupKey(group: TranscriptEntry[]): string {
	return group.map(entry => `${entry.id}:${entry.bytes}:${Math.trunc(entry.mtimeMs)}`).sort().join('|');
}

/** Claude transcripts fully contained in a later fork of the same chat. */
export async function selectRedundant(
	entries: TranscriptEntry[],
	usage: TranscriptUsage,
	options: { signal?: AbortSignal; now?: number } = {}
): Promise<RedundantTranscript[]> {
	const now = options.now ?? Date.now();
	const candidates = entries.filter(entry =>
		entry.engine === 'claude-code' &&
		!entry.sidecarOnly &&
		!usage.active.has(entry.id) &&
		now - entry.mtimeMs >= TRANSCRIPT_GRACE_MS
	);

	const live = new Set<string>();
	const redundant: RedundantTranscript[] = [];
	for (const group of groupByOwner(candidates, usage.owners)) {
		if (options.signal?.aborted) break;
		const key = groupKey(group);
		live.add(key);
		const cached = verdictCache.get(key);
		if (cached) {
			redundant.push(...cached);
			continue;
		}
		const members: { entry: TranscriptEntry; chain: ChainSummary }[] = [];
		for (const entry of group) {
			const chain = await readChain(entry.paths[0]);
			if (chain) members.push({ entry, chain });
		}
		const verdict = findContained(members);
		verdictCache.set(key, verdict);
		redundant.push(...verdict);
	}
	for (const key of verdictCache.keys()) if (!live.has(key)) verdictCache.delete(key);
	return redundant;
}

/** Replace each redundant transcript by an alias to its container, then delete it. */
export async function applyDedupe(redundant: RedundantTranscript[]): Promise<TranscriptRemoval> {
	const removable: TranscriptEntry[] = [];
	for (const item of redundant) {
		try {
			// Alias first: if the delete then fails, resuming through the alias is
			// still the same conversation, so the order can never strand a chat.
			recordTranscriptAlias('claude-code', item.entry.id, item.target.id, item.resumeAt);
			removable.push(item.entry);
		} catch (error) {
			debug.warn('storage', `Could not alias ${item.entry.id}:`, error);
		}
	}
	verdictCache.clear();
	return claudeTranscripts.remove(removable);
}

/** Delete orphaned transcripts and forget aliases nothing refers to. */
export async function removeOrphans(orphans: TranscriptEntry[], usage: TranscriptUsage): Promise<TranscriptRemoval> {
	const total: TranscriptRemoval = { freedBytes: 0, removed: 0, errors: [] };
	const byEngine = new Map<EngineType, TranscriptEntry[]>();
	for (const entry of orphans) {
		let list = byEngine.get(entry.engine);
		if (!list) byEngine.set(entry.engine, list = []);
		list.push(entry);
	}
	for (const [engine, list] of byEngine) {
		const store = transcriptStoreFor(engine);
		if (!store) continue;
		const result = await store.remove(list);
		total.freedBytes += result.freedBytes;
		total.removed += result.removed;
		total.errors.push(...result.errors);
	}
	pruneTranscriptAliases('claude-code', new Set(usage.refs.get('claude-code') ?? []));
	verdictCache.clear();
	return total;
}

/** Every transcript of every engine. */
export async function listAllTranscripts(signal?: AbortSignal): Promise<TranscriptEntry[]> {
	const all: TranscriptEntry[] = [];
	for (const store of transcriptStores) {
		if (signal?.aborted) break;
		try {
			all.push(...await store.list(signal));
		} catch (error) {
			debug.warn('storage', `Could not list ${store.engine} transcripts:`, error);
		}
	}
	return all;
}
