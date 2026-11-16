/**
 * Inbox — everything that needs the owner: questions an agent could not settle,
 * approvals for irreversible actions, reports, and things the assistant learned.
 */

import { getDatabase } from '../index';
import type { InboxKind, InboxStatus } from '$shared/types/assistant';

export interface InboxItemRow {
	id: string;
	kind: InboxKind;
	title: string;
	body: string;
	data: string;
	status: InboxStatus;
	mission_id: string | null;
	job_id: string | null;
	session_id: string | null;
	project_id: string | null;
	resolution: string | null;
	created_at: string;
	resolved_at: string | null;
}

/** Settled items older than this are pruned. */
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const inboxQueries = {
	create(input: {
		kind: InboxKind;
		title: string;
		body?: string;
		data?: Record<string, unknown>;
		missionId?: string | null;
		jobId?: string | null;
		sessionId?: string | null;
		projectId?: string | null;
	}): InboxItemRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		db.prepare(
			`INSERT INTO inbox_items (id, kind, title, body, data, status, mission_id, job_id, session_id, project_id, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
		).run(
			id,
			input.kind,
			input.title,
			input.body ?? '',
			JSON.stringify(input.data ?? {}),
			input.missionId ?? null,
			input.jobId ?? null,
			input.sessionId ?? null,
			input.projectId ?? null,
			new Date().toISOString()
		);
		return inboxQueries.getById(id)!;
	},

	getById(id: string): InboxItemRow | null {
		return (getDatabase().prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as InboxItemRow | undefined) ?? null;
	},

	list(options: { status?: InboxStatus | 'all'; limit?: number } = {}): InboxItemRow[] {
		const db = getDatabase();
		const limit = options.limit ?? 200;
		if (!options.status || options.status === 'all') {
			return db.prepare('SELECT * FROM inbox_items ORDER BY created_at DESC LIMIT ?').all(limit) as InboxItemRow[];
		}
		return db
			.prepare('SELECT * FROM inbox_items WHERE status = ? ORDER BY created_at DESC LIMIT ?')
			.all(options.status, limit) as InboxItemRow[];
	},

	/** What needs the owner: open questions, approvals and stuck work. Updates (reports, things learned) do not count. */
	countOpen(): number {
		const row = getDatabase()
			.prepare(`SELECT COUNT(*) AS n FROM inbox_items WHERE status = 'open' AND kind IN ('question', 'approval', 'stalled')`)
			.get() as { n: number };
		return row?.n ?? 0;
	},

	/** An open item of this kind already raised for the same subject — so a repeat does not stack. */
	findOpen(kind: InboxKind, key: { missionId?: string | null; sessionId?: string | null; dedupe?: string }): InboxItemRow | null {
		const rows = getDatabase()
			.prepare(`SELECT * FROM inbox_items WHERE status = 'open' AND kind = ? ORDER BY created_at DESC LIMIT 200`)
			.all(kind) as InboxItemRow[];
		return (
			rows.find((row) => {
				if (key.missionId && row.mission_id !== key.missionId) return false;
				if (key.sessionId && row.session_id !== key.sessionId) return false;
				if (key.dedupe) {
					try {
						return JSON.parse(row.data)?.dedupe === key.dedupe;
					} catch {
						return false;
					}
				}
				return true;
			}) ?? null
		);
	},

	resolve(id: string, status: Exclude<InboxStatus, 'open'>, resolution: Record<string, unknown> | null = null): InboxItemRow | null {
		getDatabase()
			.prepare(`UPDATE inbox_items SET status = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
			.run(status, resolution ? JSON.stringify(resolution) : null, new Date().toISOString(), id);
		return inboxQueries.getById(id);
	},

	/** Clear an item that was already settled (a delivered update) from the owner's view. */
	dismissSettled(id: string): void {
		getDatabase().prepare(`UPDATE inbox_items SET status = 'dismissed' WHERE id = ? AND status = 'resolved'`).run(id);
	},

	/** Settle every open item tied to a mission (it finished or was cancelled). */
	prune(): void {
		getDatabase()
			.prepare(`DELETE FROM inbox_items WHERE status != 'open' AND resolved_at < ?`)
			.run(new Date(Date.now() - SETTLED_RETENTION_MS).toISOString());
	}
};
