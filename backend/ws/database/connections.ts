/**
 * Database Manager - Connection CRUD
 * Credentials (password) are stored AES-256-GCM encrypted.
 * All mutating operations are gated by the RBAC permission service.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { settingsQueries, dbRbacQueries } from '../../database/queries';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import { testConnection } from '../../db-manager';
import {
	encryptConnectionCredentials,
	decryptConnectionCredentials,
	encryptSSHTunnelCredentials,
	decryptSSHTunnelCredentials,
	sanitizeSSHTunnelForClient
} from '../../db-manager/crypto';
import { resolveIdentity, assertCan } from '../../db-manager/rbac';
import { ws } from '$backend/utils/ws';

const STORAGE_KEY = 'db-manager:connections';

function loadConnections(): DBConnectionConfig[] {
	try {
		const setting = settingsQueries.get(STORAGE_KEY);
		if (!setting) return [];
		return JSON.parse(setting.value as string) as DBConnectionConfig[];
	} catch {
		return [];
	}
}

function saveConnections(connections: DBConnectionConfig[]): void {
	settingsQueries.set(STORAGE_KEY, JSON.stringify(connections));
}

/**
 * Return only the connections the calling user may view.
 * App admins see all connections.
 * Regular users see connections where they have an explicit permission.
 */
function filterVisibleConnections(
	connections: DBConnectionConfig[],
	userId: string,
	appRole: 'admin' | 'member' | null
): DBConnectionConfig[] {
	if (appRole === 'admin') return connections;
	const allowed = new Set(dbRbacQueries.listUserConnectionIds(userId));
	return connections.filter((c) => allowed.has(c.id));
}

/**
 * Sanitise a connection for the client: mask plaintext credentials.
 */
function sanitizeForClient(conn: DBConnectionConfig): DBConnectionConfig {
	let result = conn.password ? { ...conn, password: '••••••••' } : { ...conn };
	result = sanitizeSSHTunnelForClient(result) as DBConnectionConfig;
	return result;
}

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const DBTypeSchema = t.Union([
	t.Literal('sqlite'),
	t.Literal('postgresql'),
	t.Literal('mysql'),
	t.Literal('mariadb'),
	t.Literal('mongodb'),
	t.Literal('redis'),
	t.Literal('mssql')
]);

const SSHTunnelConfigSchema = t.Optional(
	t.Object({
		enabled: t.Boolean(),
		host: t.String(),
		port: t.Number(),
		username: t.String(),
		authMethod: t.Union([t.Literal('password'), t.Literal('key')]),
		password: t.Optional(t.String()),
		privateKey: t.Optional(t.String()),
		passphrase: t.Optional(t.String()),
		remoteHost: t.Optional(t.String()),
		remotePort: t.Optional(t.Number())
	})
);

const DBConnectionConfigSchema = t.Object({
	id: t.String(),
	name: t.String(),
	type: DBTypeSchema,
	color: t.Optional(t.String()),
	path: t.Optional(t.String()),
	host: t.Optional(t.String()),
	port: t.Optional(t.Number()),
	database: t.Optional(t.String()),
	username: t.Optional(t.String()),
	password: t.Optional(t.String()),
	ssl: t.Optional(t.Boolean()),
	sshTunnel: SSHTunnelConfigSchema,
	createdAt: t.String(),
	updatedAt: t.String(),
	lastConnectedAt: t.Optional(t.String())
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const connectionsHandler = createRouter()
	// List all saved connections visible to the caller
	.http(
		'db:connections:list',
		{ data: t.Object({}), response: t.Array(DBConnectionConfigSchema) },
		async ({ conn }) => {
			const state = ws.getConnectionState(conn);
			if (!state?.userId) return [];
			const all = loadConnections();
			const visible = filterVisibleConnections(all, state.userId, state.role);
			return visible.map(sanitizeForClient);
		}
	)

	// Create a new connection
	.http(
		'db:connections:create',
		{
			data: t.Object({
				name: t.String({ minLength: 1 }),
				type: DBTypeSchema,
				color: t.Optional(t.String()),
				path: t.Optional(t.String()),
				host: t.Optional(t.String()),
				port: t.Optional(t.Number()),
				database: t.Optional(t.String()),
				username: t.Optional(t.String()),
				password: t.Optional(t.String()),
				ssl: t.Optional(t.Boolean()),
				sshTunnel: SSHTunnelConfigSchema
			}),
			response: DBConnectionConfigSchema
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);

			const connections = loadConnections();
			const now = new Date().toISOString();
			const id = nanoid();

			const raw: DBConnectionConfig = { ...data, id, createdAt: now, updatedAt: now };

			// Encrypt DB password + SSH tunnel credentials
			let encrypted = await encryptConnectionCredentials(raw);
			encrypted = await encryptSSHTunnelCredentials(encrypted) as DBConnectionConfig;
			connections.push(encrypted);
			saveConnections(connections);

			dbRbacQueries.grantPermission({
				id: nanoid(),
				connectionId: id,
				userId,
				role: 'owner',
				grantedBy: userId,
				grantedAt: now
			});

			return sanitizeForClient(raw);
		}
	)

	// Update an existing connection
	.http(
		'db:connections:update',
		{
			data: t.Object({
				id: t.String(),
				name: t.Optional(t.String()),
				color: t.Optional(t.String()),
				path: t.Optional(t.String()),
				host: t.Optional(t.String()),
				port: t.Optional(t.Number()),
				database: t.Optional(t.String()),
				username: t.Optional(t.String()),
				password: t.Optional(t.String()),
				ssl: t.Optional(t.Boolean()),
				sshTunnel: SSHTunnelConfigSchema
			}),
			response: DBConnectionConfigSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.id, 'connection:update');

			const connections = loadConnections();
			const idx = connections.findIndex((c) => c.id === data.id);
			if (idx === -1) throw new Error('Connection not found');

			// DB password: keep stored unless a new non-placeholder value is provided
			let passwordToStore = connections[idx].password;
			if (data.password && data.password !== '••••••••') {
				const { encrypt } = await import('../../db-manager/crypto');
				passwordToStore = await encrypt(data.password);
			}

			// SSH tunnel: re-encrypt changed fields; keep stored values for placeholders
			let sshTunnelToStore = connections[idx].sshTunnel;
			if (data.sshTunnel) {
				const { encrypt } = await import('../../db-manager/crypto');
				const incoming = data.sshTunnel;
				const stored = connections[idx].sshTunnel ?? {} as any;
				sshTunnelToStore = {
					...stored,
					...incoming,
					password: incoming.password && incoming.password !== '••••••••'
						? await encrypt(incoming.password)
						: stored.password,
					privateKey: incoming.privateKey && incoming.privateKey !== '••••••••'
						? await encrypt(incoming.privateKey)
						: stored.privateKey,
					passphrase: incoming.passphrase && incoming.passphrase !== '••••••••'
						? await encrypt(incoming.passphrase)
						: stored.passphrase
				};
			}

			const updated: DBConnectionConfig = {
				...connections[idx],
				...data,
				password: passwordToStore,
				sshTunnel: sshTunnelToStore,
				updatedAt: new Date().toISOString()
			};
			connections[idx] = updated;
			saveConnections(connections);
			return sanitizeForClient(updated);
		}
	)

	// Delete a connection
	.http(
		'db:connections:delete',
		{ data: t.Object({ id: t.String() }), response: t.Object({ ok: t.Boolean() }) },
		async ({ data, conn }) => {
			assertCan(conn, data.id, 'connection:delete');
			const connections = loadConnections().filter((c) => c.id !== data.id);
			saveConnections(connections);
			dbRbacQueries.clearConnectionPermissions(data.id);
			return { ok: true };
		}
	)

	// Test a connection (without saving) — no RBAC check needed
	.http(
		'db:connections:test',
		{
			data: t.Object({
				type: DBTypeSchema,
				path: t.Optional(t.String()),
				host: t.Optional(t.String()),
				port: t.Optional(t.Number()),
				database: t.Optional(t.String()),
				username: t.Optional(t.String()),
				password: t.Optional(t.String()),
				ssl: t.Optional(t.Boolean()),
				sshTunnel: SSHTunnelConfigSchema
			}),
			response: t.Object({
				success: t.Boolean(),
				message: t.String(),
				version: t.Optional(t.String()),
				latencyMs: t.Optional(t.Number())
			})
		},
		async ({ data }) => {
			const config: DBConnectionConfig = {
				id: '',
				name: '',
				createdAt: '',
				updatedAt: '',
				...data
			};
			return testConnection(config);
		}
	);

/**
 * Resolve a connection by ID, decrypting all credentials for use by adapters.
 * Exported so other handlers (query, schema, erd, history) can reuse it.
 */
export async function getDecryptedConnection(id: string): Promise<DBConnectionConfig> {
	const setting = settingsQueries.get(STORAGE_KEY);
	if (!setting) throw new Error('No connections found');
	const connections = JSON.parse(setting.value as string) as DBConnectionConfig[];
	const conn = connections.find((c) => c.id === id);
	if (!conn) throw new Error('Connection not found');
	let decrypted = await decryptConnectionCredentials(conn);
	decrypted = await decryptSSHTunnelCredentials(decrypted) as DBConnectionConfig;
	return decrypted;
}
