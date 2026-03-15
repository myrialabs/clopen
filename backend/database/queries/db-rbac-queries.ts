import { getDatabase } from '../index';
import type { DBConnectionPermission, DBAuditLogEntry, DBConnectionRole } from '$shared/types/db-rbac';

// ─── Raw row shapes ───────────────────────────────────────────────────────────

interface RawPermissionRow {
	id: string;
	connection_id: string;
	user_id: string;
	role: DBConnectionRole;
	granted_by: string;
	granted_at: string;
	user_name?: string;
	user_color?: string;
	user_avatar?: string;
}

interface RawAuditRow {
	id: string;
	connection_id: string;
	connection_name: string;
	user_id: string;
	user_name: string;
	action: string;
	sql: string | null;
	table_name: string | null;
	row_count: number | null;
	execution_time_ms: number | null;
	success: number;
	error: string | null;
	ip_address: string | null;
	performed_at: string;
	before_data: string | null;
	after_data: string | null;
	pk_column: string | null;
	pk_value: string | null;
}

// ─── Converters ───────────────────────────────────────────────────────────────

function toPermission(row: RawPermissionRow): DBConnectionPermission {
	return {
		id: row.id,
		connectionId: row.connection_id,
		userId: row.user_id,
		role: row.role,
		grantedBy: row.granted_by,
		grantedAt: row.granted_at,
		userName: row.user_name,
		userColor: row.user_color,
		userAvatar: row.user_avatar
	};
}

function toAuditEntry(row: RawAuditRow): DBAuditLogEntry {
	return {
		id: row.id,
		connectionId: row.connection_id,
		connectionName: row.connection_name,
		userId: row.user_id,
		userName: row.user_name,
		action: row.action,
		sql: row.sql,
		tableName: row.table_name,
		rowCount: row.row_count,
		executionTimeMs: row.execution_time_ms,
		success: row.success === 1,
		error: row.error,
		ipAddress: row.ip_address,
		performedAt: row.performed_at,
		beforeData: row.before_data,
		afterData: row.after_data,
		pkColumn: row.pk_column,
		pkValue: row.pk_value
	};
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const dbRbacQueries = {
	// ─── Connection Permissions ──────────────────────────────────────────────

	/** Get all permissions for a connection, joined with user display info */
	listPermissions(connectionId: string): DBConnectionPermission[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT p.*, u.name AS user_name, u.color AS user_color, u.avatar AS user_avatar
			FROM db_connection_permissions p
			LEFT JOIN users u ON u.id = p.user_id
			WHERE p.connection_id = ?
			ORDER BY p.granted_at ASC
		`).all(connectionId) as RawPermissionRow[];
		return rows.map(toPermission);
	},

	/** Get a single permission for a user on a connection */
	getPermission(connectionId: string, userId: string): DBConnectionPermission | null {
		const db = getDatabase();
		const row = db.prepare(`
			SELECT * FROM db_connection_permissions
			WHERE connection_id = ? AND user_id = ?
		`).get(connectionId, userId) as RawPermissionRow | null;
		return row ? toPermission(row) : null;
	},

	/** Get all connection IDs a user has explicit permission on */
	listUserConnectionIds(userId: string): string[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT connection_id FROM db_connection_permissions WHERE user_id = ?
		`).all(userId) as { connection_id: string }[];
		return rows.map((r) => r.connection_id);
	},

	/** Grant or update a permission (upsert) */
	grantPermission(params: {
		id: string;
		connectionId: string;
		userId: string;
		role: DBConnectionRole;
		grantedBy: string;
		grantedAt: string;
	}): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO db_connection_permissions
				(id, connection_id, user_id, role, granted_by, granted_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(connection_id, user_id) DO UPDATE SET
				role = excluded.role,
				granted_by = excluded.granted_by,
				granted_at = excluded.granted_at
		`).run(
			params.id,
			params.connectionId,
			params.userId,
			params.role,
			params.grantedBy,
			params.grantedAt
		);
	},

	/** Revoke a user's permission on a connection */
	revokePermission(connectionId: string, userId: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM db_connection_permissions
			WHERE connection_id = ? AND user_id = ?
		`).run(connectionId, userId);
	},

	/** Remove all permissions for a connection (called on connection delete) */
	clearConnectionPermissions(connectionId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM db_connection_permissions WHERE connection_id = ?').run(connectionId);
	},

	// ─── Audit Log ───────────────────────────────────────────────────────────

	/** Append a new audit log entry */
	addAuditEntry(entry: DBAuditLogEntry): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO db_audit_log
				(id, connection_id, connection_name, user_id, user_name, action,
				 sql, table_name, row_count, execution_time_ms, success, error,
				 ip_address, performed_at, before_data, after_data, pk_column, pk_value)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			entry.id,
			entry.connectionId,
			entry.connectionName,
			entry.userId,
			entry.userName,
			entry.action,
			entry.sql ?? null,
			entry.tableName ?? null,
			entry.rowCount ?? null,
			entry.executionTimeMs ?? null,
			entry.success ? 1 : 0,
			entry.error ?? null,
			entry.ipAddress ?? null,
			entry.performedAt,
			entry.beforeData ?? null,
			entry.afterData ?? null,
			entry.pkColumn ?? null,
			entry.pkValue ?? null
		);
	},

	/** Get a single audit entry by ID */
	getAuditEntry(id: string): DBAuditLogEntry | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM db_audit_log WHERE id = ?').get(id) as RawAuditRow | null;
		return row ? toAuditEntry(row) : null;
	},

	/** List audit entries for a connection, newest first */
	listAuditEntries(connectionId: string, limit = 200): DBAuditLogEntry[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM db_audit_log
			WHERE connection_id = ?
			ORDER BY performed_at DESC
			LIMIT ?
		`).all(connectionId, limit) as RawAuditRow[];
		return rows.map(toAuditEntry);
	},

	/** List all audit entries across connections (admin view), newest first */
	listAllAuditEntries(limit = 500): DBAuditLogEntry[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM db_audit_log
			ORDER BY performed_at DESC
			LIMIT ?
		`).all(limit) as RawAuditRow[];
		return rows.map(toAuditEntry);
	},

	/** Delete audit entries older than a given ISO timestamp */
	pruneAuditLog(olderThan: string): number {
		const db = getDatabase();
		const result = db.prepare(`
			DELETE FROM db_audit_log WHERE performed_at < ?
		`).run(olderThan) as { changes: number };
		return result.changes;
	}
};
