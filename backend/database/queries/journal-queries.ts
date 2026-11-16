/**
 * The journal and the secrets store.
 *
 * Journal — what happened, in order: every exchange with Clopen, every task
 * started and finished, every automation result. Short lines, bounded size.
 *
 * Secrets — passwords, tokens and keys, sealed with the install's master key.
 * Read back only through `secretQueries.reveal`, which records the use.
 */

import { getDatabase } from '../index';
import { open, seal } from '../crypto/envelope';

export interface JournalEntryRow {
	id: number;
	kind: string;
	text: string;
	session_id: string | null;
	project_id: string | null;
	mission_id: string | null;
	job_id: string | null;
	created_at: string;
}

/** Entries kept — months of activity at a few lines a turn. */
const JOURNAL_KEPT = 20_000;

export const journalQueries = {
	add(entry: { kind: string; text: string; sessionId?: string | null; projectId?: string | null; missionId?: string | null; jobId?: string | null }): void {
		const db = getDatabase();
		db.prepare(
			`INSERT INTO journal_entries (kind, text, session_id, project_id, mission_id, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(
			entry.kind,
			entry.text.slice(0, 2000),
			entry.sessionId ?? null,
			entry.projectId ?? null,
			entry.missionId ?? null,
			entry.jobId ?? null,
			new Date().toISOString()
		);
		db.prepare(`DELETE FROM journal_entries WHERE id <= (SELECT MAX(id) FROM journal_entries) - ?`).run(JOURNAL_KEPT);
	},

	since(iso: string, limit = 60): JournalEntryRow[] {
		return getDatabase()
			.prepare('SELECT * FROM (SELECT * FROM journal_entries WHERE created_at >= ? ORDER BY id DESC LIMIT ?) ORDER BY id')
			.all(iso, limit) as JournalEntryRow[];
	},

	latest(limit = 30): JournalEntryRow[] {
		return getDatabase()
			.prepare('SELECT * FROM (SELECT * FROM journal_entries ORDER BY id DESC LIMIT ?) ORDER BY id')
			.all(limit) as JournalEntryRow[];
	},

	forSession(sessionId: string, limit = 20): JournalEntryRow[] {
		return getDatabase()
			.prepare('SELECT * FROM (SELECT * FROM journal_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
			.all(sessionId, limit) as JournalEntryRow[];
	},

	/** Every word must appear; newest first. */
	search(query: string, limit = 30): JournalEntryRow[] {
		const words = query
			.toLowerCase()
			.split(/\s+/)
			.filter((word) => word.length > 1)
			.slice(0, 8);
		if (words.length === 0) return journalQueries.latest(limit);
		const where = words.map(() => 'LOWER(text) LIKE ?').join(' AND ');
		return getDatabase()
			.prepare(`SELECT * FROM journal_entries WHERE ${where} ORDER BY id DESC LIMIT ?`)
			.all(...words.map((word) => `%${word}%`), limit) as JournalEntryRow[];
	}
};

export interface SecretRow {
	id: string;
	name: string;
	description: string;
	value: string;
	created_by: 'user' | 'assistant';
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

export type SecretSummary = Omit<SecretRow, 'value'>;

export function normaliseSecretName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

export const secretQueries = {
	/** Create or replace a secret by name. */
	save(input: { name: string; value: string; description?: string; createdBy?: 'user' | 'assistant' }): SecretSummary {
		const db = getDatabase();
		const name = normaliseSecretName(input.name);
		if (!name) throw new Error('A secret needs a name.');
		const now = new Date().toISOString();
		const sealed = seal(input.value) ?? '';
		const existing = db.prepare('SELECT id FROM secrets WHERE name = ?').get(name) as { id: string } | undefined;
		if (existing) {
			db.prepare('UPDATE secrets SET value = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?').run(
				sealed,
				input.description ?? null,
				now,
				existing.id
			);
		} else {
			db.prepare(
				`INSERT INTO secrets (id, name, description, value, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
			).run(crypto.randomUUID(), name, input.description ?? '', sealed, input.createdBy ?? 'user', now, now);
		}
		return secretQueries.get(name)!;
	},

	list(): SecretSummary[] {
		return getDatabase()
			.prepare('SELECT id, name, description, created_by, created_at, updated_at, last_used_at FROM secrets ORDER BY name')
			.all() as SecretSummary[];
	},

	get(name: string): SecretSummary | null {
		return (
			(getDatabase()
				.prepare('SELECT id, name, description, created_by, created_at, updated_at, last_used_at FROM secrets WHERE name = ?')
				.get(normaliseSecretName(name)) as SecretSummary | undefined) ?? null
		);
	},

	/** The plain value, or null when missing or unreadable. Records the use. */
	reveal(name: string): string | null {
		const db = getDatabase();
		const row = db.prepare('SELECT id, value FROM secrets WHERE name = ?').get(normaliseSecretName(name)) as { id: string; value: string } | undefined;
		if (!row) return null;
		db.prepare('UPDATE secrets SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
		return open(row.value);
	},

	delete(name: string): boolean {
		const result = getDatabase().prepare('DELETE FROM secrets WHERE name = ?').run(normaliseSecretName(name)) as { changes: number | bigint };
		return Number(result.changes ?? 0) > 0;
	}
};
