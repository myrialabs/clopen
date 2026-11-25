/**
 * Per-chat size and engine references, measured once and kept.
 *
 * Two questions Storage asks are answered by reading every message row: how
 * many bytes a chat takes, and which engine session ids it still refers to (the
 * second decides which engine transcripts are in use — resume picks the session
 * id stored on the message the user continues from, so ANY message's id can be
 * resumed again). On a database whose message table is several gigabytes that
 * read takes tens of seconds, so it is done one chat at a time, yielding between
 * chats, and cached in `storage_session_index` against the chat's
 * `message_count` and `last_message_at`. A rescan re-reads only chats that moved.
 */

import { getDatabase } from '$backend/database';
import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { yieldToEventLoop } from './fs-size';

export interface EngineRef {
	engine: EngineType;
	id: string;
}

export interface SessionIndexRow {
	sessionId: string;
	projectId: string;
	bytes: number;
	refs: EngineRef[];
	lastMessageAt: string | null;
	startedAt: string;
	slimmedAt: string | null;
	worktreeId: string | null;
}

interface StaleRow {
	id: string;
	message_count: number | null;
	last_message_at: string | null;
}

/** Read one chat's messages and return what the index stores for it. */
export function measureSession(sessionId: string): { bytes: number; refs: EngineRef[] } {
	const db = getDatabase();
	const rows = db.prepare(`
		SELECT LENGTH(CAST(data AS BLOB)) AS len,
			json_extract(data, '$.sessionId') AS sid,
			json_extract(data, '$.parent.sessionId') AS psid,
			json_extract(data, '$.engine.type') AS engine
		FROM messages WHERE session_id = ?
	`).all(sessionId) as { len: number | null; sid: string | null; psid: string | null; engine: string | null }[];

	let bytes = 0;
	const refs = new Map<string, EngineRef>();
	const add = (engine: string | null, id: string | null) => {
		// A message's `sessionId` is the ENGINE session. A user message carries the
		// chat id there in some older rows, which is not an engine reference.
		if (!id || id === sessionId || !engine) return;
		refs.set(`${engine}\u0000${id}`, { engine: engine as EngineType, id });
	};
	for (const row of rows) {
		bytes += row.len ?? 0;
		add(row.engine, row.sid);
		add(row.engine, row.psid);
	}

	const session = db.prepare('SELECT engine, head_session_id FROM chat_sessions WHERE id = ?')
		.get(sessionId) as { engine: string | null; head_session_id: string | null } | null;
	if (session) add(session.engine, session.head_session_id);

	return { bytes, refs: [...refs.values()] };
}

function staleSessions(): StaleRow[] {
	return getDatabase().prepare(`
		SELECT cs.id, cs.message_count, cs.last_message_at
		FROM chat_sessions cs
		LEFT JOIN storage_session_index i ON i.session_id = cs.id
		WHERE i.session_id IS NULL
		   OR i.message_count IS NOT COALESCE(cs.message_count, 0)
		   OR i.last_message_at IS NOT cs.last_message_at
	`).all() as StaleRow[];
}

/** Write a fresh index row for one chat. */
export function reindexSession(sessionId: string): void {
	const db = getDatabase();
	const session = db.prepare('SELECT message_count, last_message_at FROM chat_sessions WHERE id = ?')
		.get(sessionId) as { message_count: number | null; last_message_at: string | null } | null;
	if (!session) return;
	const { bytes, refs } = measureSession(sessionId);
	db.prepare(`
		INSERT INTO storage_session_index (session_id, bytes, engine_refs, message_count, last_message_at, measured_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			bytes = excluded.bytes,
			engine_refs = excluded.engine_refs,
			message_count = excluded.message_count,
			last_message_at = excluded.last_message_at,
			measured_at = excluded.measured_at
	`).run(sessionId, bytes, JSON.stringify(refs), session.message_count ?? 0, session.last_message_at, new Date().toISOString());
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Bring the index up to date. Single-flighted: a cleanup and a scan that both
 * need a fresh index share one pass.
 */
export function refreshSessionIndex(options: {
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
} = {}): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		const stale = staleSessions();
		if (stale.length > 0) debug.log('storage', `Indexing ${stale.length} chat(s)`);
		for (let i = 0; i < stale.length; i++) {
			if (options.signal?.aborted) break;
			try {
				reindexSession(stale[i].id);
			} catch (error) {
				debug.warn('storage', `Could not index chat ${stale[i].id}:`, error);
			}
			options.onProgress?.(i + 1, stale.length);
			await yieldToEventLoop();
		}
	})().finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
}

/** True when every chat has a current index row. */
export function isSessionIndexComplete(): boolean {
	return staleSessions().length === 0;
}

/**
 * Bring the index up to date and PROVE it is, before anything is deleted on its
 * word. A refresh joined from a scan that was then cancelled, or a chat that
 * failed to index, would otherwise leave references missing — and a missing
 * reference reads as "unused". Chats streaming right now are exempt: their rows
 * lag by the newest turn, whose transcript is protected by the stream itself
 * and by the grace period.
 */
export async function ensureFreshSessionIndex(streaming: Set<string>): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		await refreshSessionIndex();
		if (staleSessions().every(row => streaming.has(row.id))) return;
	}
	throw new Error('The chat index could not be brought up to date, so nothing was removed. Try again.');
}

export function readSessionIndex(): SessionIndexRow[] {
	const rows = getDatabase().prepare(`
		SELECT cs.id, cs.project_id, cs.started_at, cs.last_message_at, cs.slimmed_at, cs.worktree_id,
			COALESCE(i.bytes, 0) AS bytes, COALESCE(i.engine_refs, '[]') AS engine_refs
		FROM chat_sessions cs
		LEFT JOIN storage_session_index i ON i.session_id = cs.id
	`).all() as {
		id: string; project_id: string; started_at: string; last_message_at: string | null;
		slimmed_at: string | null; worktree_id: string | null; bytes: number; engine_refs: string;
	}[];

	return rows.map(row => {
		let refs: EngineRef[] = [];
		try {
			refs = JSON.parse(row.engine_refs) as EngineRef[];
		} catch { /* treated as no references */ }
		return {
			sessionId: row.id,
			projectId: row.project_id,
			bytes: row.bytes,
			refs,
			lastMessageAt: row.last_message_at,
			startedAt: row.started_at,
			slimmedAt: row.slimmed_at,
			worktreeId: row.worktree_id
		};
	});
}

/**
 * Every engine session id a chat still refers to, per engine, plus which chats
 * refer to each. Callers must refresh the index first; a stale index would
 * under-report references and let a cleanup remove a transcript in use.
 */
export function collectEngineRefs(rows: SessionIndexRow[] = readSessionIndex()): {
	byEngine: Map<EngineType, Set<string>>;
	owners: Map<string, Set<string>>;
} {
	const byEngine = new Map<EngineType, Set<string>>();
	const owners = new Map<string, Set<string>>();
	for (const row of rows) {
		// A slimmed chat gave its transcripts up on purpose; continuing it replays
		// the conversation instead of resuming, so they protect nothing.
		if (row.slimmedAt) continue;
		for (const ref of row.refs) {
			let ids = byEngine.get(ref.engine);
			if (!ids) byEngine.set(ref.engine, ids = new Set());
			ids.add(ref.id);
			let chats = owners.get(ref.id);
			if (!chats) owners.set(ref.id, chats = new Set());
			chats.add(row.sessionId);
		}
	}
	return { byEngine, owners };
}
