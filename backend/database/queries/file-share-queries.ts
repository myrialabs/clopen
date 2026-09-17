/**
 * File Share Queries
 *
 * Storage for shareable single-file links ("Share Link…" in the File
 * Explorer). Only the token's SHA-256 hash is stored; the raw token lives in
 * the shared URL and is never written down.
 *
 * Everything a caller can act on is keyed by `id`, not by the token: the raw
 * token exists once, in the browser that minted it, so a revoke keyed on the
 * secret would be unreachable the moment that view closes.
 *
 * A NULL `expires_at` means "until revoked" — every query that filters on the
 * deadline has to admit that row, which is why the condition is spelled out
 * rather than left to a plain comparison (SQL comparisons against NULL are
 * neither true nor false, so `expires_at > ?` alone would silently hide them).
 */

import { getDatabase } from '../index';
import { nanoid } from 'nanoid';

export interface FileShareRow {
	id: string;
	token_hash: string;
	file_path: string;
	created_by: string;
	/** 1 = dies on the first open, 0 = openable until it expires or is revoked. */
	one_time: number;
	/** ISO deadline, or null for a link that only a revoke ends. */
	expires_at: string | null;
	consumed_at: string | null;
	consumer_hash: string | null;
	open_count: number;
	last_opened_at: string | null;
	created_at: string;
}

/** A row joined with its creator's display name, for the management list. */
export interface FileShareListRow extends FileShareRow {
	created_by_name: string | null;
}

export interface CreateFileShareParams {
	tokenHash: string;
	filePath: string;
	createdBy: string;
	oneTime: boolean;
	expiresAt: string | null;
	createdAt: string;
}

const LIST_SELECT = `
	SELECT s.*, u.name AS created_by_name
	FROM file_shares s
	LEFT JOIN users u ON u.id = s.created_by
`;

/** Rows that have not passed their deadline — including the ones without one. */
const LIVE = '(s.expires_at IS NULL OR s.expires_at > ?)';

export const fileShareQueries = {
	create(params: CreateFileShareParams): FileShareRow {
		const db = getDatabase();
		const id = nanoid();
		db.prepare(`
			INSERT INTO file_shares (
				id, token_hash, file_path, created_by, one_time, expires_at,
				consumed_at, consumer_hash, open_count, last_opened_at, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?)
		`).run(
			id,
			params.tokenHash,
			params.filePath,
			params.createdBy,
			params.oneTime ? 1 : 0,
			params.expiresAt,
			params.createdAt
		);
		return db.prepare('SELECT * FROM file_shares WHERE id = ?').get(id) as FileShareRow;
	},

	getByHash(tokenHash: string): FileShareRow | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM file_shares WHERE token_hash = ?').get(tokenHash) as FileShareRow | null;
	},

	getById(id: string): FileShareRow | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM file_shares WHERE id = ?').get(id) as FileShareRow | null;
	},

	/** Every live link, newest first — the admin view of what is currently open. */
	listAll(now: string): FileShareListRow[] {
		const db = getDatabase();
		return db.prepare(`${LIST_SELECT} WHERE ${LIVE} ORDER BY s.created_at DESC`)
			.all(now) as FileShareListRow[];
	},

	/** One user's live links, newest first. */
	listForUser(userId: string, now: string): FileShareListRow[] {
		const db = getDatabase();
		return db.prepare(`${LIST_SELECT} WHERE s.created_by = ? AND ${LIVE} ORDER BY s.created_at DESC`)
			.all(userId, now) as FileShareListRow[];
	},

	/**
	 * Burn the single use of a one-time link. Conditional on `consumed_at IS
	 * NULL` and on the deadline, so exactly one of any number of concurrent
	 * opens gets `changes === 1` — the same single-use guarantee
	 * `markDeviceCodeClaimed` relies on.
	 */
	consume(tokenHash: string, consumedAt: string, consumerHash: string): number {
		const db = getDatabase();
		const result = db.prepare(`
			UPDATE file_shares
			SET consumed_at = ?, consumer_hash = ?, open_count = open_count + 1, last_opened_at = ?
			WHERE token_hash = ?
				AND one_time = 1
				AND consumed_at IS NULL
				AND (expires_at IS NULL OR expires_at > ?)
		`).run(consumedAt, consumerHash, consumedAt, tokenHash, consumedAt) as { changes: number };
		return result.changes;
	},

	/** Record an open of a reusable link — the counter the list reports from. */
	recordOpen(tokenHash: string, openedAt: string): number {
		const db = getDatabase();
		const result = db.prepare(`
			UPDATE file_shares
			SET open_count = open_count + 1, last_opened_at = ?
			WHERE token_hash = ?
		`).run(openedAt, tokenHash) as { changes: number };
		return result.changes;
	},

	deleteById(id: string): number {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM file_shares WHERE id = ?').run(id) as { changes: number };
		return result.changes;
	},

	deleteByHash(tokenHash: string): number {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM file_shares WHERE token_hash = ?').run(tokenHash) as { changes: number };
		return result.changes;
	},

	/**
	 * Remove links that can never serve bytes again: past their deadline, or
	 * burned longer ago than the streaming-continuation window. A link without
	 * a deadline is never swept — ending it is a deliberate revoke.
	 */
	deleteStale(drainCutoff: string): number {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(`
			DELETE FROM file_shares
			WHERE (expires_at IS NOT NULL AND expires_at < ?)
				OR (consumed_at IS NOT NULL AND consumed_at < ?)
		`).run(now, drainCutoff) as { changes: number };
		return result.changes;
	}
};
