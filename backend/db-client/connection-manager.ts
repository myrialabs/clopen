/**
 * db-client — connection manager.
 *
 * Singleton that lazily opens driver adapters (and SSH tunnels when
 * required), reuses them across calls, and evicts entries that have
 * been idle for more than IDLE_MS.
 */

import { dbClientConnectionQueries } from '../database/queries';
import { openSshTunnel, type SshTunnel } from './ssh-tunnel';
import { MysqlAdapter } from './drivers/mysql';
import { PostgresAdapter } from './drivers/postgres';
import { SqliteAdapter } from './drivers/sqlite';
import { MongoDbAdapter } from './drivers/mongodb';
import { RedisAdapter } from './drivers/redis';
import { MssqlAdapter } from './drivers/mssql';
import type { DbClientDriverAdapter } from './drivers/types';
import type {
	DbClientConnection,
	DbClientConnectionInput,
	DbClientHealth,
	DbDriver
} from '$shared/types/db-client';
import { debug } from '$shared/utils/logger';

interface ConnectionEntry {
	adapter: DbClientDriverAdapter;
	tunnel: SshTunnel | null;
	lastUsedAt: number;
}

// Tear an idle adapter (and its pool) down quickly so a browsed connection
// doesn't hold server-side sessions after the user walks away. The adapter is
// reopened transparently on next use.
const IDLE_MS = 60 * 1000; // 1 minute
const SWEEP_INTERVAL_MS = 30 * 1000; // 30 seconds

class ConnectionManager {
	private entries = new Map<string, ConnectionEntry>();
	private sweeperHandle: ReturnType<typeof setInterval> | null = null;

	private startSweeper(): void {
		if (this.sweeperHandle) return;
		this.sweeperHandle = setInterval(() => {
			this.sweepIdle().catch((err) => {
				debug.warn('db-client', 'idle sweep error:', err);
			});
		}, SWEEP_INTERVAL_MS);
		// Don't keep the process alive just for this timer.
		(this.sweeperHandle as unknown as { unref?: () => void }).unref?.();
	}

	private buildAdapter(driver: DbDriver): DbClientDriverAdapter {
		switch (driver) {
			case 'mysql': return new MysqlAdapter();
			case 'postgres': return new PostgresAdapter();
			case 'sqlite': return new SqliteAdapter();
			case 'mongodb': return new MongoDbAdapter();
			case 'redis': return new RedisAdapter();
			case 'mssql': return new MssqlAdapter();
			default: {
				const exhaustive: never = driver;
				throw new Error(`Unsupported driver: ${exhaustive}`);
			}
		}
	}

	private async openEntry(conn: DbClientConnection): Promise<ConnectionEntry> {
		const adapter = this.buildAdapter(conn.driver);
		let tunnel: SshTunnel | null = null;

		if (conn.ssh.enabled && conn.driver !== 'sqlite') {
			const remoteHost = conn.host || '127.0.0.1';
			const remotePort = conn.port ?? defaultPortFor(conn.driver);
			tunnel = await openSshTunnel(conn.ssh, remoteHost, remotePort);
		}

		try {
			await adapter.connect(conn, tunnel?.localPort);
		} catch (err) {
			if (tunnel) await tunnel.close().catch((err) => {
				debug.warn('db-client', 'Failed to close SSH tunnel after adapter connect error:', err);
			});
			throw err;
		}

		return { adapter, tunnel, lastUsedAt: Date.now() };
	}

	/**
	 * Get (or open) the live adapter for a saved connection.
	 * Marks the connection as used on success.
	 */
	async get(connectionId: string): Promise<DbClientDriverAdapter> {
		this.startSweeper();

		const existing = this.entries.get(connectionId);
		if (existing && existing.adapter.isAlive()) {
			existing.lastUsedAt = Date.now();
			return existing.adapter;
		}
		if (existing) {
			await this.releaseEntry(connectionId, existing);
		}

		const conn = dbClientConnectionQueries.get(connectionId);
		if (!conn) throw new Error('db-client connection not found');

		const entry = await this.openEntry(conn);
		this.entries.set(connectionId, entry);
		dbClientConnectionQueries.markUsed(connectionId);
		return entry.adapter;
	}

	/**
	 * Open a one-shot adapter for an unsaved input (used by Test before save).
	 * Caller is responsible for calling `close()` and `tunnel?.close()`.
	 */
	async openTransient(input: DbClientConnectionInput): Promise<{
		adapter: DbClientDriverAdapter;
		tunnel: SshTunnel | null;
	}> {
		const conn = inputToConnection(input);
		const entry = await this.openEntry(conn);
		return { adapter: entry.adapter, tunnel: entry.tunnel };
	}

	/**
	 * Run a health check for a saved connection or an unsaved input.
	 * Returns a structured `DbClientHealth` rather than throwing on
	 * connection-level errors so the UI can show the failure reason.
	 */
	async test(target: { id: string } | DbClientConnectionInput): Promise<DbClientHealth> {
		const isSaved = 'id' in target && typeof target.id === 'string';

		// Re-use the existing live adapter for saved connections.
		if (isSaved) {
			try {
				const adapter = await this.get(target.id);
				const health = await adapter.health();
				if (!health.ok) return { ...health, sshOk: this.sshStatus(target.id) };
				return { ...health, sshOk: this.sshStatus(target.id) };
			} catch (err) {
				return {
					ok: false,
					latencyMs: null,
					serverVersion: null,
					sshOk: null,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}

		// Transient probe for unsaved input.
		const input = target as DbClientConnectionInput;
		let adapter: DbClientDriverAdapter | null = null;
		let tunnel: SshTunnel | null = null;
		const sshRequested = input.ssh?.enabled === true;
		try {
			const opened = await this.openTransient(input);
			adapter = opened.adapter;
			tunnel = opened.tunnel;
			const health = await adapter.health();
			return { ...health, sshOk: sshRequested ? tunnel !== null : null };
		} catch (err) {
			return {
				ok: false,
				latencyMs: null,
				serverVersion: null,
				sshOk: sshRequested ? false : null,
				error: err instanceof Error ? err.message : String(err)
			};
		} finally {
			if (adapter) await adapter.close().catch((err) => {
				debug.warn('db-client', 'Transient adapter close error during health test:', err);
			});
			if (tunnel) await tunnel.close().catch((err) => {
				debug.warn('db-client', 'Transient tunnel close error during health test:', err);
			});
		}
	}

	private sshStatus(connectionId: string): boolean | null {
		const entry = this.entries.get(connectionId);
		if (!entry) return null;
		return entry.tunnel ? true : null;
	}

	async release(connectionId: string): Promise<void> {
		const entry = this.entries.get(connectionId);
		if (!entry) return;
		await this.releaseEntry(connectionId, entry);
	}

	private async releaseEntry(connectionId: string, entry: ConnectionEntry): Promise<void> {
		this.entries.delete(connectionId);
		await entry.adapter.close().catch((err) => {
			debug.warn('db-client', `adapter close error (${connectionId}):`, err);
		});
		if (entry.tunnel) {
			await entry.tunnel.close().catch((err) => {
				debug.warn('db-client', `tunnel close error (${connectionId}):`, err);
			});
		}
	}

	private async sweepIdle(): Promise<void> {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (now - entry.lastUsedAt > IDLE_MS || !entry.adapter.isAlive()) {
				debug.log('db-client', `idle sweep: closing ${id}`);
				await this.releaseEntry(id, entry);
			}
		}
	}

	async closeAll(): Promise<void> {
		const ids = [...this.entries.keys()];
		for (const id of ids) await this.release(id);
		if (this.sweeperHandle) {
			clearInterval(this.sweeperHandle);
			this.sweeperHandle = null;
		}
	}
}

function defaultPortFor(driver: DbDriver): number {
	switch (driver) {
		case 'mysql': return 3306;
		case 'postgres': return 5432;
		case 'mongodb': return 27017;
		case 'redis': return 6379;
		case 'mssql': return 1433;
		case 'sqlite': return 0;
	}
}

function inputToConnection(input: DbClientConnectionInput): DbClientConnection {
	const now = new Date().toISOString();
	return {
		id: 'transient',
		name: input.name,
		driver: input.driver,
		host: input.host ?? null,
		port: input.port ?? null,
		username: input.username ?? null,
		password: input.password ?? null,
		database: input.database ?? null,
		sslMode: input.sslMode ?? 'disable',
		sslCa: input.sslCa ?? null,
		ssh: {
			enabled: input.ssh?.enabled ?? false,
			host: input.ssh?.host ?? '',
			port: input.ssh?.port ?? 22,
			username: input.ssh?.username ?? '',
			authMethod: input.ssh?.authMethod ?? 'password',
			password: input.ssh?.password ?? '',
			privateKey: input.ssh?.privateKey ?? '',
			passphrase: input.ssh?.passphrase ?? ''
		},
		options: input.options ?? {},
		color: input.color ?? null,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: null
	};
}

export const connectionManager = new ConnectionManager();
