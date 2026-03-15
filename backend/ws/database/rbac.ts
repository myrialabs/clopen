/**
 * Database Manager - RBAC Permission & Audit Log Handlers
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { dbRbacQueries, authQueries } from '../../database/queries';
import { ws } from '$backend/utils/ws';
import { resolveIdentity, assertCan } from '../../db-manager/rbac';
import { executeQuery, generateRollbackSql } from '../../db-manager';
import { getDecryptedConnection } from './connections';
import type { DBConnectionRole } from '$shared/types/db-rbac';

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const PermissionSchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	userId: t.String(),
	role: t.Union([t.Literal('owner'), t.Literal('developer'), t.Literal('viewer')]),
	grantedBy: t.String(),
	grantedAt: t.String(),
	userName: t.Optional(t.String()),
	userColor: t.Optional(t.String()),
	userAvatar: t.Optional(t.String())
});

const AuditEntrySchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	connectionName: t.String(),
	userId: t.String(),
	userName: t.String(),
	action: t.String(),
	sql: t.Optional(t.Union([t.String(), t.Null()])),
	tableName: t.Optional(t.Union([t.String(), t.Null()])),
	rowCount: t.Optional(t.Union([t.Number(), t.Null()])),
	executionTimeMs: t.Optional(t.Union([t.Number(), t.Null()])),
	success: t.Boolean(),
	error: t.Optional(t.Union([t.String(), t.Null()])),
	ipAddress: t.Optional(t.Union([t.String(), t.Null()])),
	performedAt: t.String(),
	beforeData: t.Optional(t.Union([t.String(), t.Null()])),
	afterData: t.Optional(t.Union([t.String(), t.Null()])),
	pkColumn: t.Optional(t.Union([t.String(), t.Null()])),
	pkValue: t.Optional(t.Union([t.String(), t.Null()]))
});

const AppUserSchema = t.Object({
	id: t.String(),
	name: t.String(),
	color: t.String(),
	avatar: t.String(),
	role: t.Union([t.Literal('admin'), t.Literal('member')])
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const rbacHandler = createRouter()
	// List all permissions for a connection
	.http(
		'db:rbac:permissions:list',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Array(PermissionSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'permissions:manage');
			return dbRbacQueries.listPermissions(data.connectionId);
		}
	)

	// Grant or update a permission
	.http(
		'db:rbac:permissions:grant',
		{
			data: t.Object({
				connectionId: t.String(),
				userId: t.String(),
				role: t.Union([t.Literal('owner'), t.Literal('developer'), t.Literal('viewer')])
			}),
			response: PermissionSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'permissions:manage');
			const { userId: grantedBy } = resolveIdentity(conn);
			const now = new Date().toISOString();
			const id = nanoid();
			dbRbacQueries.grantPermission({
				id,
				connectionId: data.connectionId,
				userId: data.userId,
				role: data.role as DBConnectionRole,
				grantedBy,
				grantedAt: now
			});
			const perm = dbRbacQueries.getPermission(data.connectionId, data.userId)!;
			// Enrich with user display info
			const user = authQueries.getUserById(data.userId);
			return {
				...perm,
				userName: user?.name,
				userColor: user?.color,
				userAvatar: user?.avatar
			};
		}
	)

	// Revoke a permission
	.http(
		'db:rbac:permissions:revoke',
		{
			data: t.Object({ connectionId: t.String(), userId: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'permissions:manage');
			// Prevent self-revoke of last owner
			const { userId } = resolveIdentity(conn);
			if (data.userId === userId) {
				const perms = dbRbacQueries.listPermissions(data.connectionId);
				const ownerCount = perms.filter((p) => p.role === 'owner').length;
				if (ownerCount <= 1) {
					throw new Error('Cannot revoke the last owner of a connection');
				}
			}
			dbRbacQueries.revokePermission(data.connectionId, data.userId);
			return { ok: true };
		}
	)

	// Get the calling user's own role on a connection
	.http(
		'db:rbac:my-role',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Object({
				role: t.Union([
					t.Literal('owner'),
					t.Literal('developer'),
					t.Literal('viewer'),
					t.Null()
				])
			})
		},
		async ({ data, conn }): Promise<{ role: DBConnectionRole | null }> => {
			const state = ws.getConnectionState(conn);
			if (!state?.userId) return { role: null };
			if (state.role === 'admin') return { role: 'owner' as const };
			const perm = dbRbacQueries.getPermission(data.connectionId, state.userId);
			return { role: perm?.role ?? null };
		}
	)

	// List all app users (for the permission grant picker)
	.http(
		'db:rbac:users:list',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Array(AppUserSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'permissions:manage');
			const db = (await import('../../database/index')).getDatabase();
			const rows = db.prepare(`
				SELECT id, name, color, avatar, role FROM users ORDER BY name ASC
			`).all() as { id: string; name: string; color: string; avatar: string; role: 'admin' | 'member' }[];
			return rows;
		}
	)

	// View audit log for a connection
	.http(
		'db:rbac:audit:list',
		{
			data: t.Object({
				connectionId: t.String(),
				limit: t.Optional(t.Number())
			}),
			response: t.Array(AuditEntrySchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'audit:view');
			return dbRbacQueries.listAuditEntries(data.connectionId, data.limit ?? 200);
		}
	)

	// Prune audit log entries older than N days (owner only)
	.http(
		'db:rbac:audit:prune',
		{
			data: t.Object({
				connectionId: t.String(),
				olderThanDays: t.Number({ minimum: 1 })
			}),
			response: t.Object({ deleted: t.Number() })
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'permissions:manage');
			const cutoff = new Date(Date.now() - data.olderThanDays * 86_400_000).toISOString();
			const deleted = dbRbacQueries.pruneAuditLog(cutoff);
			return { deleted };
		}
	)

	// Rollback a logged DML operation (owner only)
	.http(
		'db:audit:rollback',
		{
			data: t.Object({
				connectionId: t.String(),
				auditEntryId: t.String()
			}),
			response: t.Object({
				ok: t.Boolean(),
				rollbackSql: t.Array(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:rollback');

			const entry = dbRbacQueries.getAuditEntry(data.auditEntryId);
			if (!entry) throw new Error('Audit entry not found');
			if (entry.connectionId !== data.connectionId) throw new Error('Connection mismatch');
			if (!entry.tableName) throw new Error('Audit entry has no table name — cannot rollback');

			const config = await getDecryptedConnection(data.connectionId);

			// Parse stored JSON snapshots
			const beforeData = entry.beforeData ? JSON.parse(entry.beforeData) : null;
			const pkValue = entry.pkValue != null ? JSON.parse(entry.pkValue) : null;

			const rollbackSql = generateRollbackSql({
				action: entry.action,
				tableName: entry.tableName,
				dbType: config.type,
				beforeData,
				pkColumn: entry.pkColumn ?? null,
				pkValue
			});

			// Execute each rollback statement
			for (const sql of rollbackSql) {
				const result = await executeQuery(config, sql);
				if (result.error) throw new Error(`Rollback failed: ${result.error}`);
			}

			// Audit the rollback itself
			const { userId } = resolveIdentity(conn);
			const state = ws.getConnectionState(conn);
			const userName = state?.userId
				? (authQueries.getUserById(state.userId)?.name ?? state.userId)
				: 'unknown';

			dbRbacQueries.addAuditEntry({
				id: nanoid(),
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: 'data:rollback',
				sql: rollbackSql.join(';\n'),
				tableName: entry.tableName,
				rowCount: rollbackSql.length,
				executionTimeMs: null,
				success: true,
				error: null,
				ipAddress: ws.getRemoteAddress(conn) ?? null,
				performedAt: new Date().toISOString()
			});

			return { ok: true, rollbackSql };
		}
	);
