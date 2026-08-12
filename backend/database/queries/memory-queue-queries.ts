/**
 * The memory extraction queue (migration 066).
 *
 * Everything about "which turn is waiting to be summarised, and when" lives
 * here. The scheduler decides timing policy; this decides how that policy is
 * persisted, and it is persisted precisely so that a crash, a restart or a model
 * outage does not quietly cost the user a conversation's worth of memory.
 *
 * The unique index on `session_id` carries real semantics: enqueueing a turn for
 * a session that already has one MERGES into it and keeps the older
 * `user_message_id`. That is the "bank the oldest boundary" rule — the transcript
 * runs from that message to the end of the chain, so the older boundary covers
 * every turn since — expressed as an upsert rather than as branching in the
 * caller.
 */

import { getDatabase } from '../index';
import type { MemoryQueueStatus } from '$shared/types/memory';

export interface QueuedExtraction {
	id: number;
	sessionId: string;
	projectId: string;
	projectPath: string;
	userMessageId: string;
	changedPaths: string[];
	deletedPaths: string[];
	injectedMemoryIds: string[];
	attempts: number;
	lastError: string | null;
	status: 'pending' | 'failed';
	readyAt: string;
	createdAt: string;
	/**
	 * Bumped every time a turn merges into this row.
	 *
	 * Read by the runner when it claims an entry and quoted back when it deletes
	 * one, so a turn that merged in while the previous was being summarised cannot
	 * be thrown away with it. See `remove`.
	 */
	revision: number;
}

interface QueueRow {
	id: number;
	session_id: string;
	project_id: string;
	project_path: string;
	user_message_id: string;
	changed_paths: string;
	deleted_paths: string;
	injected_ids: string;
	attempts: number;
	last_error: string | null;
	status: 'pending' | 'failed';
	ready_at: string;
	created_at: string;
	revision: number | null;
}

/** Tolerant of a malformed column: a bad row should cost its paths, not the turn. */
function parseList(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

function toEntry(row: QueueRow): QueuedExtraction {
	return {
		id: row.id,
		sessionId: row.session_id,
		projectId: row.project_id,
		projectPath: row.project_path,
		userMessageId: row.user_message_id,
		changedPaths: parseList(row.changed_paths),
		deletedPaths: parseList(row.deleted_paths),
		injectedMemoryIds: parseList(row.injected_ids),
		attempts: row.attempts,
		lastError: row.last_error,
		status: row.status,
		readyAt: row.ready_at,
		createdAt: row.created_at,
		revision: row.revision ?? 0
	};
}

export interface EnqueueInput {
	sessionId: string;
	projectId: string;
	projectPath: string;
	userMessageId: string;
	changedPaths: string[];
	deletedPaths?: string[];
	injectedMemoryIds?: string[];
	/** Seconds from now before this becomes eligible to run. */
	delaySeconds: number;
}

export const memoryQueueQueries = {
	/**
	 * Park a turn, or merge it into the one already parked for this session.
	 *
	 * A merge deliberately keeps the OLDER boundary and unions the path lists,
	 * because the eventual extraction reads one transcript covering all of it. It
	 * also resets `attempts` and clears the failure: new material is new evidence,
	 * and refusing to retry because an earlier version of this span failed would
	 * strand the session permanently.
	 */
	enqueue(input: EnqueueInput): void {
		const db = getDatabase();
		const existing = db
			.prepare(`SELECT * FROM memory_extraction_queue WHERE session_id = ?`)
			.get(input.sessionId) as QueueRow | null;

		if (!existing) {
			db.prepare(
				`INSERT INTO memory_extraction_queue (
					session_id, project_id, project_path, user_message_id,
					changed_paths, deleted_paths, injected_ids, ready_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
			).run(
				input.sessionId,
				input.projectId,
				input.projectPath,
				input.userMessageId,
				JSON.stringify(input.changedPaths),
				JSON.stringify(input.deletedPaths ?? []),
				JSON.stringify(input.injectedMemoryIds ?? []),
				`+${Math.max(0, Math.round(input.delaySeconds))} seconds`
			);
			return;
		}

		const merged = toEntry(existing);
		db.prepare(
			`UPDATE memory_extraction_queue
			 SET changed_paths = ?, deleted_paths = ?, injected_ids = ?,
			     attempts = 0, last_error = NULL, status = 'pending',
			     ready_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP,
			     revision = revision + 1
			 WHERE id = ?`
		).run(
			JSON.stringify([...new Set([...merged.changedPaths, ...input.changedPaths])]),
			JSON.stringify([...new Set([...merged.deletedPaths, ...(input.deletedPaths ?? [])])]),
			JSON.stringify([...new Set([...merged.injectedMemoryIds, ...(input.injectedMemoryIds ?? [])])]),
			`+${Math.max(0, Math.round(input.delaySeconds))} seconds`,
			existing.id
		);
	},

	/**
	 * Hold a session's entry while it is streaming — but never past a ceiling.
	 *
	 * A summary generated mid-answer competes with the answer, so a new stream
	 * pushes the pending entry out. The ceiling is what stops that being
	 * unbounded: `created_at + maxDeferSeconds` is a hard stop, so a session that
	 * never goes quiet is summarised anyway rather than accumulating a span longer
	 * than the transcript budget can carry — in which case the head of the span,
	 * where the decisions usually are, is what falls off.
	 *
	 * Entries mid-backoff are left alone: their schedule is a retry policy, not a
	 * politeness delay, and pulling it forward would burn attempts.
	 */
	deferUntilStreamEnds(sessionId: string, maxDeferSeconds: number): void {
		getDatabase()
			.prepare(
				`UPDATE memory_extraction_queue
				 SET ready_at = MIN(datetime('now', '+300 seconds'), datetime(created_at, ?)),
				     updated_at = CURRENT_TIMESTAMP
				 WHERE session_id = ? AND status = 'pending' AND attempts = 0`
			)
			.run(`+${Math.max(0, Math.round(maxDeferSeconds))} seconds`, sessionId);
	},

	/**
	 * How many entries are due now or imminently.
	 *
	 * Distinct from "pending", and the difference is what keeps maintenance
	 * running: an entry waiting on a condition the user has to fix stays pending
	 * indefinitely by design, and treating that as "somebody is working" stood the
	 * whole maintenance loop down permanently.
	 */
	dueWithin(seconds: number): number {
		return (
			getDatabase()
				.prepare(
					`SELECT COUNT(*) AS c FROM memory_extraction_queue
					 WHERE status = 'pending' AND ready_at <= datetime('now', ?)`
				)
				.get(`+${Math.max(0, Math.round(seconds))} seconds`) as { c: number }
		).c;
	},

	/**
	 * Drop entries whose session no longer exists.
	 *
	 * Sessions are deleted through several paths and only some of them cancel
	 * their extraction; a project being removed takes its sessions with it without
	 * this queue ever hearing. Each orphan is a row that can never succeed, is
	 * retried forever, and shows in the status counts as work outstanding.
	 */
	pruneOrphans(): number {
		const result = getDatabase()
			.prepare(
				`DELETE FROM memory_extraction_queue
				 WHERE session_id NOT IN (SELECT id FROM chat_sessions)`
			)
			.run() as { changes?: number };
		return Number(result.changes ?? 0);
	},

	/** Entries whose time has come, oldest first. */
	due(limit = 5): QueuedExtraction[] {
		const rows = getDatabase()
			.prepare(
				`SELECT * FROM memory_extraction_queue
				 WHERE status = 'pending' AND ready_at <= datetime('now')
				 ORDER BY ready_at ASC
				 LIMIT ?`
			)
			.all(limit) as QueueRow[];
		return rows.map(toEntry);
	},

	/** Everything queued, regardless of readiness — used by `flush` on shutdown. */
	all(): QueuedExtraction[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM memory_extraction_queue ORDER BY ready_at ASC`)
			.all() as QueueRow[];
		return rows.map(toEntry);
	},

	get(sessionId: string): QueuedExtraction | null {
		const row = getDatabase()
			.prepare(`SELECT * FROM memory_extraction_queue WHERE session_id = ?`)
			.get(sessionId) as QueueRow | null;
		return row ? toEntry(row) : null;
	},

	/**
	 * Done with — the turn was summarised, or there was nothing in it to keep.
	 *
	 * CONDITIONAL on the revision the caller claimed. Extraction runs the moment a
	 * turn ends, so another turn can finish and MERGE into this row while it is
	 * being summarised; deleting unconditionally would take that turn's boundary
	 * and paths with it, silently, on the only write path in the feature. A
	 * mismatch means the row has moved on and must stay for the next pass.
	 *
	 * Returns whether the row was actually removed.
	 */
	remove(id: number, revision?: number): boolean {
		const result = (
			revision === undefined
				? getDatabase().prepare(`DELETE FROM memory_extraction_queue WHERE id = ?`).run(id)
				: getDatabase()
						.prepare(`DELETE FROM memory_extraction_queue WHERE id = ? AND revision = ?`)
						.run(id, revision)
		) as { changes?: number };
		return Number(result.changes ?? 0) > 0;
	},

	removeBySession(sessionId: string): void {
		getDatabase().prepare(`DELETE FROM memory_extraction_queue WHERE session_id = ?`).run(sessionId);
	},

	/**
	 * Record a failed attempt and schedule the retry.
	 *
	 * `countsAsAttempt: false` is for conditions that are not the turn's fault and
	 * would never succeed sooner by trying harder — chiefly "no model is
	 * configured". Burning attempts on those would mark the entry failed within
	 * minutes and lose the turn for a reason the user can fix at their leisure.
	 */
	recordFailure(id: number, error: string, delaySeconds: number, options?: { countsAsAttempt?: boolean }): void {
		const counts = options?.countsAsAttempt ?? true;
		getDatabase()
			.prepare(
				`UPDATE memory_extraction_queue
				 SET attempts = attempts + ?, last_error = ?,
				     ready_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`
			)
			.run(counts ? 1 : 0, error.slice(0, 500), `+${Math.max(1, Math.round(delaySeconds))} seconds`, id);
	},

	/** Attempts exhausted. Kept rather than deleted, so it stays visible. */
	markFailed(id: number, error: string): void {
		getDatabase()
			.prepare(
				`UPDATE memory_extraction_queue
				 SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`
			)
			.run(error.slice(0, 500), id);
	},

	/**
	 * Put failed entries back in the queue.
	 *
	 * Called on startup as well as from the UI: a restart usually means something
	 * changed — a model was configured, an account re-authenticated, an engine
	 * upgraded — and the most common cause of exhaustion is exactly that kind of
	 * fixable condition.
	 */
	retryFailed(): number {
		const result = getDatabase()
			.prepare(
				`UPDATE memory_extraction_queue
				 SET status = 'pending', attempts = 0, ready_at = datetime('now'),
				     updated_at = CURRENT_TIMESTAMP
				 WHERE status = 'failed'`
			)
			.run() as { changes?: number };
		return Number(result.changes ?? 0);
	},

	/**
	 * Drop entries too old to still be worth summarising.
	 *
	 * The queue banks a turn until a model can read it, which is right for the
	 * hours or days it usually takes someone to configure one. It stops being
	 * right at some point: the transcript it points at may have been compacted or
	 * paginated away, and a summary of a conversation from six weeks ago is not
	 * what the person who finally picks a model is waiting for.
	 */
	pruneStale(maxAgeDays: number): number {
		const result = getDatabase()
			.prepare(
				`DELETE FROM memory_extraction_queue
				 WHERE julianday('now') - julianday(created_at) > ?`
			)
			.run(maxAgeDays) as { changes?: number };
		return Number(result.changes ?? 0);
	},

	/** Drop everything queued, for "clear all data" and for tests. */
	clear(): void {
		getDatabase().prepare(`DELETE FROM memory_extraction_queue`).run();
	},

	/** What the UI shows: how much is waiting, how much is stuck, and why. */
	status(): Omit<MemoryQueueStatus, 'running' | 'modelConfigured'> {
		const db = getDatabase();
		const counts = db
			.prepare(
				`SELECT
					SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
					SUM(CASE WHEN status = 'pending' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
				 FROM memory_extraction_queue`
			)
			.get() as { pending: number | null; retrying: number | null; failed: number | null };

		const next = db
			.prepare(
				`SELECT ready_at FROM memory_extraction_queue
				 WHERE status = 'pending' ORDER BY ready_at ASC LIMIT 1`
			)
			.get() as { ready_at: string } | null;

		// The most recent error across the queue, whatever its status — one message
		// explains a stalled queue far better than a count does.
		const error = db
			.prepare(
				`SELECT last_error FROM memory_extraction_queue
				 WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
			)
			.get() as { last_error: string } | null;

		return {
			pending: counts.pending ?? 0,
			retrying: counts.retrying ?? 0,
			failed: counts.failed ?? 0,
			nextAttemptAt: next?.ready_at ?? null,
			lastError: error?.last_error ?? null
		};
	}
};
