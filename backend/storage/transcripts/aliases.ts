/**
 * Deduplicated transcripts, remembered as "resume this other one, cut here".
 *
 * A row says: engine session `session_id` no longer has a file of its own; the
 * same conversation state is `target_session_id` resumed at entry `resume_at`.
 * Chains are flattened as they form — when a target is itself deduplicated, the
 * rows pointing at it are re-pointed at the new target in the same statement —
 * so resolution is normally one lookup.
 */

import { getDatabase } from '$backend/database';
import type { EngineType } from '$shared/types/unified';

export interface TranscriptAlias {
	targetSessionId: string;
	resumeAt: string;
}

/** Where `sessionId` lives now, or null when it was never deduplicated. */
export function resolveTranscriptAlias(engine: EngineType, sessionId: string): TranscriptAlias | null {
	const db = getDatabase();
	const lookup = db.prepare(
		'SELECT target_session_id, resume_at FROM engine_transcript_aliases WHERE engine = ? AND session_id = ?'
	);
	let row = lookup.get(engine, sessionId) as { target_session_id: string; resume_at: string } | null;
	if (!row) return null;
	const resumeAt = row.resume_at;
	let target = row.target_session_id;
	// Flattened on write; followed here only in case a write was interrupted.
	for (let hops = 0; hops < 32; hops++) {
		row = lookup.get(engine, target) as { target_session_id: string; resume_at: string } | null;
		if (!row) break;
		target = row.target_session_id;
	}
	return { targetSessionId: target, resumeAt };
}

export function recordTranscriptAlias(engine: EngineType, sessionId: string, targetSessionId: string, resumeAt: string): void {
	const db = getDatabase();
	const write = () => {
		db.prepare(`
			INSERT INTO engine_transcript_aliases (engine, session_id, target_session_id, resume_at, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(engine, session_id) DO UPDATE SET
				target_session_id = excluded.target_session_id,
				resume_at = excluded.resume_at
		`).run(engine, sessionId, targetSessionId, resumeAt, new Date().toISOString());
		db.prepare('UPDATE engine_transcript_aliases SET target_session_id = ? WHERE engine = ? AND target_session_id = ?')
			.run(targetSessionId, engine, sessionId);
	};
	if (db.transaction) db.transaction(write)();
	else write();
}

/** Every session id some alias resumes into. Those transcripts are in use. */
export function transcriptAliasTargets(engine: EngineType): Set<string> {
	const rows = getDatabase().prepare('SELECT DISTINCT target_session_id FROM engine_transcript_aliases WHERE engine = ?')
		.all(engine) as { target_session_id: string }[];
	return new Set(rows.map(row => row.target_session_id));
}

/** Forget aliases no chat refers to any more. Returns how many went. */
export function pruneTranscriptAliases(engine: EngineType, referenced: Set<string>): number {
	const db = getDatabase();
	const rows = db.prepare('SELECT session_id FROM engine_transcript_aliases WHERE engine = ?')
		.all(engine) as { session_id: string }[];
	const stale = rows.map(row => row.session_id).filter(id => !referenced.has(id));
	const remove = db.prepare('DELETE FROM engine_transcript_aliases WHERE engine = ? AND session_id = ?');
	const prune = () => {
		for (const id of stale) remove.run(engine, id);
	};
	if (db.transaction) db.transaction(prune)();
	else prune();
	return stale.length;
}
