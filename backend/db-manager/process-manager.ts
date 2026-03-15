/**
 * Database Process Manager Service
 *
 * Executes engine-specific "list active sessions" queries and returns
 * normalised DBProcess records. Also handles Kill Session / Kill Query.
 *
 * Supported engines:
 *   mysql/mariadb  → SHOW FULL PROCESSLIST / KILL QUERY|CONNECTION
 *   postgresql     → pg_stat_activity / pg_cancel_backend | pg_terminate_backend
 *   mssql          → sys.dm_exec_requests / KILL
 *   mongodb        → currentOp / killOp
 *   redis          → CLIENT LIST / CLIENT KILL
 *   sqlite         → not supported
 */

import type { DBConnectionConfig } from '$shared/types/db-manager';
import type { DBProcess, DBProcessList, KillMode, KillProcessResult } from '$shared/types/process-manager';
import { withSSHTunnel } from './ssh-tunnel';

// ─── Internal adapter helpers ─────────────────────────────────────────────────

async function runSql(config: DBConnectionConfig, sql: string): Promise<Record<string, unknown>[]> {
	const { executeQuery } = await import('./index');
	const result = await executeQuery(config, sql);
	if (result.error) throw new Error(result.error);
	return result.rows;
}

// ─── List Processes ───────────────────────────────────────────────────────────

export async function listProcesses(config: DBConnectionConfig): Promise<DBProcessList> {
	// withSSHTunnel is already applied inside executeQuery, but we wrap here so
	// MongoDB/Redis paths (which bypass executeQuery) also get tunnelled.
	return withSSHTunnel(config, (c) => _listProcesses(c));
}

async function _listProcesses(config: DBConnectionConfig): Promise<DBProcessList> {
	const fetchedAt = new Date().toISOString();

	switch (config.type) {
		// ── MySQL / MariaDB ──────────────────────────────────────────────────
		case 'mysql':
		case 'mariadb': {
			const rows = await runSql(config, 'SHOW FULL PROCESSLIST');
			const processes: DBProcess[] = rows.map((row) => ({
				id: String(row['Id'] ?? row['id'] ?? ''),
				user: String(row['User'] ?? row['user'] ?? ''),
				host: String(row['Host'] ?? row['host'] ?? ''),
				database: String(row['db'] ?? row['database'] ?? ''),
				command: String(row['Command'] ?? row['command'] ?? ''),
				state: String(row['State'] ?? row['state'] ?? ''),
				query: String(row['Info'] ?? row['info'] ?? ''),
				timeSeconds: Number(row['Time'] ?? row['time'] ?? 0),
				raw: row
			}));
			return { processes, fetchedAt, dbType: config.type };
		}

		// ── PostgreSQL ───────────────────────────────────────────────────────
		case 'postgresql': {
			const sql = `
				SELECT
					pid::text                                                          AS id,
					usename                                                            AS "user",
					client_addr::text                                                  AS host,
					datname                                                            AS database,
					wait_event_type                                                    AS command,
					state,
					LEFT(COALESCE(query, ''), 300)                                     AS query,
					COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::int, 0)       AS time_seconds
				FROM pg_stat_activity
				WHERE pid <> pg_backend_pid()
				  AND state IS NOT NULL
				ORDER BY time_seconds DESC NULLS LAST
			`;
			const rows = await runSql(config, sql);
			const processes: DBProcess[] = rows.map((row) => ({
				id: String(row['id'] ?? ''),
				user: String(row['user'] ?? ''),
				host: String(row['host'] ?? ''),
				database: String(row['database'] ?? ''),
				command: String(row['command'] ?? ''),
				state: String(row['state'] ?? ''),
				query: String(row['query'] ?? ''),
				timeSeconds: Number(row['time_seconds'] ?? 0),
				raw: row
			}));
			return { processes, fetchedAt, dbType: config.type };
		}

		// ── SQL Server ───────────────────────────────────────────────────────
		case 'mssql': {
			const sql = `
				SELECT
					CAST(r.session_id AS VARCHAR)    AS id,
					s.login_name                     AS [user],
					s.host_name                      AS host,
					DB_NAME(r.database_id)           AS [database],
					r.command,
					r.status                         AS state,
					COALESCE(t.text, '')             AS query,
					r.total_elapsed_time / 1000      AS time_seconds,
					r.cpu_time                       AS cpu_ms,
					r.reads,
					r.writes
				FROM sys.dm_exec_requests r
				JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
				OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
				WHERE r.session_id <> @@SPID
				ORDER BY r.total_elapsed_time DESC
			`;
			const rows = await runSql(config, sql);
			const processes: DBProcess[] = rows.map((row) => ({
				id: String(row['id'] ?? ''),
				user: String(row['user'] ?? ''),
				host: String(row['host'] ?? ''),
				database: String(row['database'] ?? ''),
				command: String(row['command'] ?? ''),
				state: String(row['state'] ?? ''),
				query: String(row['query'] ?? ''),
				timeSeconds: Number(row['time_seconds'] ?? 0),
				cpuMs: Number(row['cpu_ms'] ?? 0),
				reads: Number(row['reads'] ?? 0),
				writes: Number(row['writes'] ?? 0),
				raw: row
			}));
			return { processes, fetchedAt, dbType: config.type };
		}

		// ── MongoDB ──────────────────────────────────────────────────────────
		case 'mongodb': {
			const { executeQuery } = await import('./index');
			// MongoDB adapter handles JSON-encoded commands
			const result = await executeQuery(config, JSON.stringify({ currentOp: true }), undefined);
			const rows = result.rows ?? [];
			const processes: DBProcess[] = rows.map((op) => ({
				id: String((op['opid'] as number | string) ?? (op['ns'] as string) ?? ''),
				user: String((op['client'] as string) ?? ''),
				host: String((op['client_s'] as string) ?? ''),
				database: String(((op['ns'] as string) ?? '').split('.')[0] ?? ''),
				command: String((op['op'] as string) ?? ''),
				state: String(op['active'] ? 'active' : 'idle'),
				query: JSON.stringify(op['command'] ?? op['query'] ?? {}),
				timeSeconds: Number((op['secs_running'] as number) ?? 0),
				raw: op
			}));
			return { processes, fetchedAt, dbType: config.type };
		}

		// ── Redis ────────────────────────────────────────────────────────────
		case 'redis': {
			const { executeQuery } = await import('./index');
			const result = await executeQuery(config, 'CLIENT LIST');
			const raw = String(
				result.rows[0]?.['CLIENT LIST'] ??
				result.rows[0]?.['result'] ??
				''
			);
			const lines = raw.split('\n').filter(Boolean);
			const processes: DBProcess[] = lines.map((line, idx) => {
				const parts: Record<string, string> = {};
				for (const kv of line.split(' ')) {
					const eq = kv.indexOf('=');
					if (eq !== -1) parts[kv.slice(0, eq)] = kv.slice(eq + 1);
				}
				return {
					id: parts['id'] ?? String(idx),
					user: parts['user'] ?? '',
					host: parts['addr'] ?? '',
					database: parts['db'] ?? '',
					command: parts['cmd'] ?? '',
					state: parts['flags'] ?? '',
					query: parts['name'] ?? '',
					timeSeconds: parseInt(parts['age'] ?? '0', 10) || 0,
					raw: parts as Record<string, unknown>
				};
			});
			return { processes, fetchedAt, dbType: config.type };
		}

		// ── SQLite / unsupported ─────────────────────────────────────────────
		default:
			return { processes: [], fetchedAt, dbType: config.type };
	}
}

// ─── Kill Process ─────────────────────────────────────────────────────────────

export async function killProcess(
	config: DBConnectionConfig,
	processId: string,
	mode: KillMode = 'query'
): Promise<KillProcessResult> {
	return withSSHTunnel(config, (c) => _killProcess(c, processId, mode));
}

async function _killProcess(
	config: DBConnectionConfig,
	processId: string,
	mode: KillMode
): Promise<KillProcessResult> {
	try {
		switch (config.type) {
			case 'mysql':
			case 'mariadb': {
				const sql = mode === 'query'
					? `KILL QUERY ${processId}`
					: `KILL CONNECTION ${processId}`;
				await runSql(config, sql);
				return { ok: true, message: `Process ${processId} ${mode === 'query' ? 'query cancelled' : 'connection terminated'}` };
			}

			case 'postgresql': {
				const fn = mode === 'query' ? 'pg_cancel_backend' : 'pg_terminate_backend';
				await runSql(config, `SELECT ${fn}(${processId})`);
				return { ok: true, message: `Process ${processId} ${mode === 'query' ? 'query cancelled' : 'connection terminated'}` };
			}

			case 'mssql': {
				await runSql(config, `KILL ${processId}`);
				return { ok: true, message: `Session ${processId} killed` };
			}

			case 'mongodb': {
				const { executeQuery } = await import('./index');
				const result = await executeQuery(
					config,
					JSON.stringify({ killOp: 1, op: Number(processId) }),
					undefined
				);
				if (result.error) return { ok: false, message: result.error };
				return { ok: true, message: `Operation ${processId} killed` };
			}

			case 'redis': {
				const { executeQuery } = await import('./index');
				const result = await executeQuery(config, `CLIENT KILL ID ${processId}`, undefined);
				if (result.error) return { ok: false, message: result.error };
				return { ok: true, message: `Client ${processId} disconnected` };
			}

			default:
				return { ok: false, message: `Kill not supported for ${config.type}` };
		}
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : 'Kill failed' };
	}
}
