/**
 * Database Manager RBAC Permission Service
 *
 * Permission matrix:
 *   Owner     — full access (all actions)
 *   Developer — DML/DDL but no DROP DATABASE and no connection deletion
 *   Viewer    — SELECT and browse only
 *
 * App-level admins (role = 'admin') are treated as Owner on every connection.
 */

import { ws } from '$backend/utils/ws';
import type { WSConnection } from '$shared/utils/ws-server';
import { DB_ROLE_PERMISSIONS, type DBAction, type DBConnectionRole } from '$shared/types/db-rbac';
import { dbRbacQueries } from '../database/queries';

// ─── SQL Classification ────────────────────────────────────────────────────────

/**
 * Classify an arbitrary SQL string into the matching DBAction.
 * Looks only at the first keyword — fast and good enough for access control.
 */
export function classifySql(sql: string): DBAction {
	const trimmed = sql.trim().toUpperCase();
	const firstWord = trimmed.split(/\s+/)[0] ?? '';

	// DROP DATABASE / DROP SCHEMA — most restrictive
	if (firstWord === 'DROP') {
		const secondWord = trimmed.split(/\s+/)[1] ?? '';
		if (secondWord === 'DATABASE' || secondWord === 'SCHEMA') {
			return 'query:drop_db';
		}
		// DROP TABLE / VIEW / INDEX → DDL
		return 'query:ddl';
	}

	switch (firstWord) {
		case 'SELECT':
		case 'WITH':   // CTEs starting with WITH are typically SELECT
		case 'SHOW':
		case 'DESCRIBE':
		case 'EXPLAIN':
		case 'PRAGMA':
			return 'query:select';

		case 'INSERT':
		case 'UPDATE':
		case 'DELETE':
		case 'TRUNCATE':
		case 'REPLACE':
		case 'MERGE':
		case 'CALL':
			return 'query:dml';

		case 'CREATE':
		case 'ALTER':
		case 'RENAME':
		case 'COMMENT':
			return 'query:ddl';

		default:
			// Conservative: treat unknown as DDL (requires developer+)
			return 'query:ddl';
	}
}

// ─── Permission Check ──────────────────────────────────────────────────────────

/**
 * Resolve the effective DB-Manager role for a user on a given connection.
 *
 * Precedence:
 *  1. App-level admin → implicit Owner on all connections
 *  2. Explicit permission stored in db_connection_permissions
 *  3. No permission record → null (access denied)
 */
export function getEffectiveRole(
	userId: string,
	appRole: 'admin' | 'member' | null,
	connectionId: string
): DBConnectionRole | null {
	// App admins always have Owner rights
	if (appRole === 'admin') return 'owner';

	const perm = dbRbacQueries.getPermission(connectionId, userId);
	return perm?.role ?? null;
}

/**
 * Check whether a user may perform a given action on a connection.
 * Returns `true` if allowed, `false` otherwise.
 */
export function can(
	userId: string,
	appRole: 'admin' | 'member' | null,
	connectionId: string,
	action: DBAction
): boolean {
	const role = getEffectiveRole(userId, appRole, connectionId);
	if (!role) return false;
	return DB_ROLE_PERMISSIONS[role].includes(action);
}

// ─── WS Connection Helpers ────────────────────────────────────────────────────

/**
 * Resolve userId and appRole from the current WS connection.
 * Throws if the user is not authenticated.
 */
export function resolveIdentity(conn: WSConnection): { userId: string; appRole: 'admin' | 'member' | null } {
	const state = ws.getConnectionState(conn);
	if (!state?.userId) throw new Error('Not authenticated');
	return { userId: state.userId, appRole: state.role };
}

/**
 * Assert that the authenticated user may perform `action` on `connectionId`.
 * Throws a human-readable error if denied.
 */
export function assertCan(
	conn: WSConnection,
	connectionId: string,
	action: DBAction
): void {
	const { userId, appRole } = resolveIdentity(conn);
	if (!can(userId, appRole, connectionId, action)) {
		const actionLabels: Record<DBAction, string> = {
			'connection:view': 'view this connection',
			'connection:create': 'create connections',
			'connection:update': 'edit this connection',
			'connection:delete': 'delete this connection',
			'query:select': 'run SELECT queries',
			'query:dml': 'run DML queries (INSERT/UPDATE/DELETE)',
			'query:ddl': 'run DDL queries (CREATE/ALTER/DROP)',
			'query:drop_db': 'drop databases',
			'data:insert': 'insert rows',
			'data:update': 'update rows',
			'data:delete': 'delete rows',
			'data:rollback': 'rollback DML operations',
			'schema:alter': 'alter table schema',
			'audit:view': 'view the audit log',
			'permissions:manage': 'manage permissions'
		};
		throw new Error(`Permission denied: you cannot ${actionLabels[action] ?? action}`);
	}
}
