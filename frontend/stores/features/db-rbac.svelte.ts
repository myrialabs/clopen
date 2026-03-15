/**
 * Database Manager RBAC Store - Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import {
	DB_ROLE_PERMISSIONS,
	type DBConnectionPermission,
	type DBAuditLogEntry,
	type DBConnectionRole
} from '$shared/types/db-rbac';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbRbacState = $state({
	/** Current user's role on the active connection (null = no access) */
	myRole: null as DBConnectionRole | null,
	/** Permission list for the permissions management modal */
	permissions: [] as DBConnectionPermission[],
	/** All app users available to grant permissions to */
	availableUsers: [] as { id: string; name: string; color: string; avatar: string; role: 'admin' | 'member' }[],
	/** Audit log entries for the active connection */
	auditEntries: [] as DBAuditLogEntry[],
	isLoadingRole: false,
	isLoadingPermissions: false,
	isLoadingAudit: false,
	isSavingPermission: false
});

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Load the calling user's role on the given connection */
export async function loadMyRole(connectionId: string): Promise<void> {
	dbRbacState.isLoadingRole = true;
	try {
		const result = await ws.http('db:rbac:my-role', { connectionId });
		dbRbacState.myRole = result?.role ?? null;
	} catch {
		dbRbacState.myRole = null;
	} finally {
		dbRbacState.isLoadingRole = false;
	}
}

/** Load all permissions for a connection (requires permissions:manage) */
export async function loadPermissions(connectionId: string): Promise<void> {
	dbRbacState.isLoadingPermissions = true;
	try {
		const [perms, users] = await Promise.all([
			ws.http('db:rbac:permissions:list', { connectionId }),
			ws.http('db:rbac:users:list', { connectionId })
		]);
		dbRbacState.permissions = perms ?? [];
		dbRbacState.availableUsers = users ?? [];
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Permissions',
			message: err instanceof Error ? err.message : 'Failed to load permissions',
			duration: 4000
		});
	} finally {
		dbRbacState.isLoadingPermissions = false;
	}
}

/** Grant or update a permission */
export async function grantPermission(
	connectionId: string,
	userId: string,
	role: DBConnectionRole
): Promise<void> {
	dbRbacState.isSavingPermission = true;
	try {
		const perm = await ws.http('db:rbac:permissions:grant', { connectionId, userId, role });
		const idx = dbRbacState.permissions.findIndex((p) => p.userId === userId);
		if (idx >= 0) {
			dbRbacState.permissions[idx] = perm;
		} else {
			dbRbacState.permissions.push(perm);
		}
		addNotification({ type: 'success', title: 'Permissions', message: 'Permission granted', duration: 2500 });
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Permissions',
			message: err instanceof Error ? err.message : 'Failed to grant permission',
			duration: 4000
		});
	} finally {
		dbRbacState.isSavingPermission = false;
	}
}

/** Revoke a user's permission */
export async function revokePermission(connectionId: string, userId: string): Promise<void> {
	dbRbacState.isSavingPermission = true;
	try {
		await ws.http('db:rbac:permissions:revoke', { connectionId, userId });
		dbRbacState.permissions = dbRbacState.permissions.filter((p) => p.userId !== userId);
		addNotification({ type: 'success', title: 'Permissions', message: 'Permission revoked', duration: 2500 });
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Permissions',
			message: err instanceof Error ? err.message : 'Failed to revoke permission',
			duration: 4000
		});
	} finally {
		dbRbacState.isSavingPermission = false;
	}
}

/** Load the audit log for a connection */
export async function loadAuditLog(connectionId: string, limit = 200): Promise<void> {
	dbRbacState.isLoadingAudit = true;
	try {
		const entries = await ws.http('db:rbac:audit:list', { connectionId, limit });
		dbRbacState.auditEntries = entries ?? [];
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Audit Log',
			message: err instanceof Error ? err.message : 'Failed to load audit log',
			duration: 4000
		});
	} finally {
		dbRbacState.isLoadingAudit = false;
	}
}

/** Prune audit log entries older than N days */
export async function pruneAuditLog(connectionId: string, olderThanDays: number): Promise<void> {
	try {
		const result = await ws.http('db:rbac:audit:prune', { connectionId, olderThanDays });
		addNotification({
			type: 'success',
			title: 'Audit Log',
			message: `Deleted ${result.deleted} old entries`,
			duration: 2500
		});
		await loadAuditLog(connectionId);
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Audit Log',
			message: err instanceof Error ? err.message : 'Failed to prune audit log',
			duration: 4000
		});
	}
}

/**
 * Rollback a logged DML operation by its audit entry ID.
 * Returns the generated rollback SQL statements on success.
 */
export async function rollbackAuditEntry(
	connectionId: string,
	auditEntryId: string
): Promise<string[] | null> {
	try {
		const result = await ws.http('db:audit:rollback', { connectionId, auditEntryId });
		addNotification({
			type: 'success',
			title: 'Rollback',
			message: `Operation rolled back (${result.rollbackSql.length} statement(s) executed)`,
			duration: 4000
		});
		await loadAuditLog(connectionId);
		return result.rollbackSql;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Rollback Failed',
			message: err instanceof Error ? err.message : 'Failed to rollback operation',
			duration: 5000
		});
		return null;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if the current user can perform the given action based on myRole */
export function canDo(action: string): boolean {
	if (!dbRbacState.myRole) return false;
	return (DB_ROLE_PERMISSIONS[dbRbacState.myRole] as string[]).includes(action);
}
