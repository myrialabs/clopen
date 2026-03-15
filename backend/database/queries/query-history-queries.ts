import { getDatabase } from '../index';
import type { QueryHistoryEntry } from '$shared/types/query-history';

interface RawHistoryRow {
	id: string;
	connection_id: string;
	connection_name: string;
	connection_type: string;
	sql: string;
	execution_time_ms: number;
	row_count: number;
	error: string | null;
	executed_at: string;
	is_favorite: number;
}

function toEntry(row: RawHistoryRow): QueryHistoryEntry {
	return {
		id: row.id,
		connectionId: row.connection_id,
		connectionName: row.connection_name,
		connectionType: row.connection_type,
		sql: row.sql,
		executionTimeMs: row.execution_time_ms,
		rowCount: row.row_count,
		error: row.error,
		executedAt: row.executed_at,
		isFavorite: row.is_favorite === 1
	};
}

export const queryHistoryQueries = {
	add(entry: Omit<QueryHistoryEntry, 'isFavorite'>): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO query_history (id, connection_id, connection_name, connection_type, sql, execution_time_ms, row_count, error, executed_at, is_favorite)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		`).run(
			entry.id,
			entry.connectionId,
			entry.connectionName,
			entry.connectionType,
			entry.sql,
			entry.executionTimeMs,
			entry.rowCount,
			entry.error ?? null,
			entry.executedAt
		);
	},

	listByConnection(connectionId: string, limit = 100): QueryHistoryEntry[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM query_history
			WHERE connection_id = ?
			ORDER BY is_favorite DESC, executed_at DESC
			LIMIT ?
		`).all(connectionId, limit) as RawHistoryRow[];
		return rows.map(toEntry);
	},

	listAll(limit = 100): QueryHistoryEntry[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM query_history
			ORDER BY is_favorite DESC, executed_at DESC
			LIMIT ?
		`).all(limit) as RawHistoryRow[];
		return rows.map(toEntry);
	},

	toggleFavorite(id: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE query_history SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END WHERE id = ?
		`).run(id);
	},

	deleteEntry(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM query_history WHERE id = ?').run(id);
	},

	clearByConnection(connectionId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM query_history WHERE connection_id = ?').run(connectionId);
	}
};
