import { getDatabase } from '../index';
import type {
	SchemaVersion,
	SchemaVersionCreateInput,
	SchemaVersionSummary
} from '$shared/types/schema-versioning';
import type { AlterChange, DBColumnDef } from '$shared/types/alter-table';

interface RawRow {
	id: string;
	connection_id: string;
	connection_name: string;
	connection_type: string;
	table_name: string;
	schema_name: string | null;
	version_number: number;
	label: string | null;
	up_sql: string;
	down_sql: string;
	changes_json: string;
	columns_before_json: string;
	columns_after_json: string;
	applied_by_id: string;
	applied_by_name: string;
	applied_at: string;
	status: string;
	notes: string | null;
}

interface RawSummaryRow {
	id: string;
	connection_id: string;
	connection_name: string;
	connection_type: string;
	table_name: string;
	schema_name: string | null;
	version_number: number;
	label: string | null;
	changes_json: string;
	applied_by_name: string;
	applied_at: string;
	status: string;
}

function parseJson<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}

function toVersion(row: RawRow): SchemaVersion {
	return {
		id: row.id,
		connectionId: row.connection_id,
		connectionName: row.connection_name,
		connectionType: row.connection_type,
		tableName: row.table_name,
		schemaName: row.schema_name,
		versionNumber: row.version_number,
		label: row.label,
		upStatements: parseJson<string[]>(row.up_sql, []),
		downStatements: parseJson<string[]>(row.down_sql, []),
		changes: parseJson<AlterChange[]>(row.changes_json, []),
		columnsBefore: parseJson<DBColumnDef[]>(row.columns_before_json, []),
		columnsAfter: parseJson<DBColumnDef[]>(row.columns_after_json, []),
		appliedById: row.applied_by_id,
		appliedByName: row.applied_by_name,
		appliedAt: row.applied_at,
		status: row.status as 'applied' | 'rolled_back',
		notes: row.notes
	};
}

function toSummary(row: RawSummaryRow): SchemaVersionSummary {
	const changes = parseJson<unknown[]>(row.changes_json, []);
	return {
		id: row.id,
		connectionId: row.connection_id,
		connectionName: row.connection_name,
		connectionType: row.connection_type,
		tableName: row.table_name,
		schemaName: row.schema_name,
		versionNumber: row.version_number,
		label: row.label,
		changesCount: changes.length,
		appliedByName: row.applied_by_name,
		appliedAt: row.applied_at,
		status: row.status as 'applied' | 'rolled_back'
	};
}

export const schemaVersionQueries = {
	add(input: SchemaVersionCreateInput): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO schema_versions (
				id, connection_id, connection_name, connection_type,
				table_name, schema_name, version_number, label,
				up_sql, down_sql, changes_json, columns_before_json, columns_after_json,
				applied_by_id, applied_by_name, applied_at, status, notes
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)
		`).run(
			input.id,
			input.connectionId,
			input.connectionName,
			input.connectionType,
			input.tableName,
			input.schemaName ?? null,
			input.versionNumber,
			input.label ?? null,
			JSON.stringify(input.upStatements),
			JSON.stringify(input.downStatements),
			JSON.stringify(input.changes),
			JSON.stringify(input.columnsBefore),
			JSON.stringify(input.columnsAfter),
			input.appliedById,
			input.appliedByName,
			input.appliedAt,
			input.notes ?? null
		);
	},

	getNextVersionNumber(connectionId: string, tableName: string): number {
		const db = getDatabase();
		const row = db
			.prepare(`
				SELECT COALESCE(MAX(version_number), 0) AS max_ver
				FROM schema_versions
				WHERE connection_id = ? AND table_name = ?
			`)
			.get(connectionId, tableName) as { max_ver: number };
		return (row.max_ver ?? 0) + 1;
	},

	listByTable(connectionId: string, tableName: string, limit = 50): SchemaVersionSummary[] {
		const db = getDatabase();
		const rows = db
			.prepare(`
				SELECT id, connection_id, connection_name, connection_type,
				       table_name, schema_name, version_number, label,
				       changes_json, applied_by_name, applied_at, status
				FROM schema_versions
				WHERE connection_id = ? AND table_name = ?
				ORDER BY version_number DESC
				LIMIT ?
			`)
			.all(connectionId, tableName, limit) as RawSummaryRow[];
		return rows.map(toSummary);
	},

	listByConnection(connectionId: string, limit = 100): SchemaVersionSummary[] {
		const db = getDatabase();
		const rows = db
			.prepare(`
				SELECT id, connection_id, connection_name, connection_type,
				       table_name, schema_name, version_number, label,
				       changes_json, applied_by_name, applied_at, status
				FROM schema_versions
				WHERE connection_id = ?
				ORDER BY applied_at DESC
				LIMIT ?
			`)
			.all(connectionId, limit) as RawSummaryRow[];
		return rows.map(toSummary);
	},

	getById(id: string): SchemaVersion | null {
		const db = getDatabase();
		const row = db
			.prepare('SELECT * FROM schema_versions WHERE id = ?')
			.get(id) as RawRow | undefined;
		return row ? toVersion(row) : null;
	},

	markRolledBack(id: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE schema_versions SET status = 'rolled_back' WHERE id = ?`).run(id);
	},

	updateLabel(id: string, label: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE schema_versions SET label = ? WHERE id = ?`).run(label, id);
	},

	deleteById(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM schema_versions WHERE id = ?').run(id);
	}
};
