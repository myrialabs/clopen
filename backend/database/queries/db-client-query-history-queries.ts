import { getDatabase } from '../index';
import type { DBDbClientQueryHistoryRow } from '$shared/types/database/schema';
import type { DbClientQueryHistoryEntry } from '$shared/types/db-client';

function rowToEntry(row: DBDbClientQueryHistoryRow): DbClientQueryHistoryEntry {
	return {
		id: row.id,
		connectionId: row.connection_id,
		userId: row.user_id,
		query: row.query,
		durationMs: row.duration_ms,
		rowCount: row.row_count,
		status: row.status,
		error: row.error,
		executedAt: row.executed_at
	};
}

interface InsertHistoryInput {
	connectionId: string;
	userId: string | null;
	query: string;
	durationMs: number | null;
	rowCount: number | null;
	status: 'success' | 'error';
	error: string | null;
}

export const dbClientQueryHistoryQueries = {
	insert(input: InsertHistoryInput): DbClientQueryHistoryEntry {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO db_client_query_history (
				id, connection_id, user_id, query,
				duration_ms, row_count, status, error, executed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id, input.connectionId, input.userId, input.query,
			input.durationMs, input.rowCount, input.status, input.error, now
		);

		const row = db.prepare(
			'SELECT * FROM db_client_query_history WHERE id = ?'
		).get(id) as DBDbClientQueryHistoryRow;
		return rowToEntry(row);
	},

	list(opts: {
		connectionId: string;
		limit?: number;
		offset?: number;
		search?: string;
	}): { items: DbClientQueryHistoryEntry[]; total: number } {
		const db = getDatabase();
		const limit = opts.limit ?? 50;
		const offset = opts.offset ?? 0;
		const search = opts.search?.trim();

		let where = 'connection_id = ?';
		const params: unknown[] = [opts.connectionId];
		if (search) {
			where += ' AND query LIKE ?';
			params.push(`%${search}%`);
		}

		const totalRow = db.prepare(
			`SELECT COUNT(*) as count FROM db_client_query_history WHERE ${where}`
		).get(...params) as { count: number };

		const rows = db.prepare(
			`SELECT * FROM db_client_query_history
			 WHERE ${where}
			 ORDER BY executed_at DESC
			 LIMIT ? OFFSET ?`
		).all(...params, limit, offset) as DBDbClientQueryHistoryRow[];

		return {
			items: rows.map(rowToEntry),
			total: totalRow.count
		};
	},

	deleteByConnection(connectionId: string): number {
		const db = getDatabase();
		const result = db.prepare(
			'DELETE FROM db_client_query_history WHERE connection_id = ?'
		).run(connectionId) as { changes: number };
		return result.changes;
	},

	deleteOne(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM db_client_query_history WHERE id = ?').run(id);
	},

	prune(connectionId: string, keep: number): number {
		const db = getDatabase();
		const result = db.prepare(`
			DELETE FROM db_client_query_history
			WHERE connection_id = ?
				AND id NOT IN (
					SELECT id FROM db_client_query_history
					WHERE connection_id = ?
					ORDER BY executed_at DESC
					LIMIT ?
				)
		`).run(connectionId, connectionId, keep) as { changes: number };
		return result.changes;
	}
};
