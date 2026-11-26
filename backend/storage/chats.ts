/**
 * Old chats: slim them, or delete them.
 *
 * Most of a chat's weight is not the conversation. Measured on a real instance,
 * 2.5 GB of a 3.4 GB message table was tool output carried on user-type rows
 * (file reads, command output, screenshots), against well under a gigabyte of
 * everything people and models actually wrote. Slimming keeps every message and
 * every word of the conversation and removes the rest:
 *
 *   - tool results and tool inputs longer than SLIM_KEEP_CHARS are cut to their
 *     head, with a note saying how much went
 *   - image and document attachments become a one-line note
 *   - file checkpoints go (the chat can no longer restore files)
 *   - the engine's transcripts go (the chat can no longer be resumed natively;
 *     continuing it replays the conversation to the engine, as switching engine
 *     does)
 *
 * A slimmed chat is marked `slimmed_at`, which also tells the transcript cleanup
 * that its old engine sessions are no longer protected. Writing a new message
 * clears the mark (see sessionQueries.updateOnMessage), so a chat that is picked
 * up again protects its new transcripts as usual.
 */

import { getDatabase } from '$backend/database';
import { snapshotQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { yieldToEventLoop } from './fs-size';
import { collectOrphanBlobs, releaseTranscripts } from './purge';
import { measureSession, reindexSession, type EngineRef } from './session-index';

/** Characters of a long tool result or input kept when slimming. */
export const SLIM_KEEP_CHARS = 2_000;
/** Strings at or below this length are left alone. */
const SLIM_THRESHOLD_CHARS = 4_096;

const DAY_MS = 24 * 60 * 60_000;

function trimmed(text: string): string {
	if (text.length <= SLIM_THRESHOLD_CHARS) return text;
	const removedKb = Math.max(1, Math.round((text.length - SLIM_KEEP_CHARS) / 1024));
	return `${text.slice(0, SLIM_KEEP_CHARS)}\n\n[… ${removedKb} KB removed by Storage cleanup]`;
}

/** Cut every long string inside a tool input, keeping its shape. */
function trimDeep(value: unknown): unknown {
	if (typeof value === 'string') return trimmed(value);
	if (Array.isArray(value)) return value.map(trimDeep);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, trimDeep(inner)]));
	}
	return value;
}

/** The slimmed form of a message, or null when nothing in it is heavy. */
export function slimMessage(message: UnifiedMessage): UnifiedMessage | null {
	if (message.type === 'user') {
		let changed = false;
		const content = message.content.map(block => {
			if (block.type === 'tool_result' && block.content.length > SLIM_THRESHOLD_CHARS) {
				changed = true;
				return { ...block, content: trimmed(block.content) };
			}
			if (block.type === 'image' || block.type === 'document') {
				changed = true;
				const label = block.type === 'image' ? 'Image' : 'Document';
				const number = block.index ? ` @${block.index}` : '';
				return { type: 'text' as const, text: `[${label}${number}${block.title ? ` "${block.title}"` : ''} removed by Storage cleanup]` };
			}
			return block;
		});
		return changed ? { ...message, content } : null;
	}
	if (message.type === 'assistant') {
		let changed = false;
		const content = message.content.map(block => {
			if (block.type !== 'tool_use') return block;
			const before = JSON.stringify(block.input ?? null);
			if (before.length <= SLIM_THRESHOLD_CHARS) return block;
			changed = true;
			return { ...block, input: trimDeep(block.input) } as typeof block;
		});
		return changed ? { ...message, content } : null;
	}
	return null;
}

export interface SlimResult {
	freedBytes: number;
	messages: number;
}

/** Slim one chat. Its rows are rewritten one at a time, yielding between batches. */
export async function slimSession(sessionId: string): Promise<SlimResult> {
	const db = getDatabase();
	const before = measureSession(sessionId);
	const rows = db.prepare('SELECT id, data FROM messages WHERE session_id = ?').all(sessionId) as { id: string; data: string }[];
	const update = db.prepare('UPDATE messages SET data = ? WHERE id = ?');

	let messages = 0;
	for (let i = 0; i < rows.length; i++) {
		let parsed: UnifiedMessage;
		try {
			parsed = JSON.parse(rows[i].data) as UnifiedMessage;
		} catch {
			continue;
		}
		const slim = slimMessage(parsed);
		if (slim) {
			update.run(JSON.stringify(slim), rows[i].id);
			messages++;
		}
		if (i % 200 === 199) await yieldToEventLoop();
	}

	const snapshots = snapshotQueries.deleteBySessionId(sessionId);
	await collectOrphanBlobs(snapshotQueries.collectBlobHashes(snapshots));

	db.prepare('UPDATE chat_sessions SET slimmed_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
	reindexSession(sessionId);
	const after = measureSession(sessionId);
	if (before.refs.length > 0) await releaseTranscripts(before.refs as EngineRef[]);

	return { freedBytes: Math.max(0, before.bytes - after.bytes), messages };
}

/**
 * Chats a "delete/slim old chats" action may touch: no activity for
 * `olderThanDays`, not streaming, and none of the chats something else points
 * at — a project's open chat, a chat app's current conversation, a chat linked
 * to an issue or pull request.
 */
export function selectOldChats(options: {
	olderThanDays: number;
	projectId?: string | null;
	excludeSlimmed?: boolean;
	active: Set<string>;
}): { id: string; projectId: string; bytes: number }[] {
	const cutoff = new Date(Date.now() - options.olderThanDays * DAY_MS).toISOString();
	const db = getDatabase();
	const rows = db.prepare(`
		SELECT cs.id, cs.project_id, COALESCE(i.bytes, 0) AS bytes
		FROM chat_sessions cs
		LEFT JOIN storage_session_index i ON i.session_id = cs.id
		WHERE COALESCE(cs.last_message_at, cs.started_at) < ?
		  AND (? IS NULL OR cs.project_id = ?)
		  AND (? = 0 OR cs.slimmed_at IS NULL)
		  AND cs.id NOT IN (SELECT current_session_id FROM workspace_projects WHERE current_session_id IS NOT NULL)
		  AND cs.id NOT IN (SELECT active_session_id FROM channel_links WHERE active_session_id IS NOT NULL)
		  AND cs.id NOT IN (SELECT session_id FROM work_links WHERE session_id IS NOT NULL)
	`).all(
		cutoff,
		options.projectId ?? null, options.projectId ?? null,
		options.excludeSlimmed ? 1 : 0
	) as { id: string; project_id: string; bytes: number }[];
	return rows
		.filter(row => !options.active.has(row.id))
		.map(row => ({ id: row.id, projectId: row.project_id, bytes: row.bytes }));
}

/** What slimming a chat would free, estimated from its size without rewriting it. */
export function estimateSlimBytes(bytes: number): number {
	// Measured ratio of heavy payload to message bytes (2.5 of 3.4 GB). An
	// estimate only; the result reports what was actually freed.
	return Math.round(bytes * 0.7);
}

export function logSlimmed(sessionId: string, result: SlimResult): void {
	debug.log('storage', `Slimmed chat ${sessionId}: ${result.messages} message(s), ${result.freedBytes} bytes`);
}
