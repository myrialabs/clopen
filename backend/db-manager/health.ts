/**
 * Database Health Metrics Collector
 *
 * Gathers performance metrics from each supported database engine:
 *   postgresql  → pg_stat_database, pg_stat_activity, pg_statio_user_tables
 *   mysql/maria → SHOW GLOBAL STATUS, INFORMATION_SCHEMA.PROCESSLIST
 *   mssql       → sys.dm_os_performance_counters, sys.dm_exec_requests
 *   sqlite      → file size only
 *   mongodb     → serverStatus command
 *   redis       → INFO all
 */

import type { DBConnectionConfig } from '$shared/types/db-manager';
import type {
	DBHealthMetrics,
	DBHealthConnections,
	DBHealthTPS,
	DBHealthMemory,
	DBHealthDisk,
	DBSlowQuery
} from '$shared/types/db-health';
import { HEALTH_THRESHOLDS } from '$shared/types/db-health';
import { withSSHTunnel } from './ssh-tunnel';

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function runSql(config: DBConnectionConfig, sql: string): Promise<Record<string, unknown>[]> {
	const { executeQuery } = await import('./index');
	const result = await executeQuery(config, sql);
	if (result.error) throw new Error(result.error);
	return result.rows;
}

/** Safe runSql — returns empty array on failure instead of throwing */
async function trySql(config: DBConnectionConfig, sql: string): Promise<Record<string, unknown>[]> {
	try {
		return await runSql(config, sql);
	} catch {
		return [];
	}
}

function num(v: unknown, fallback = 0): number {
	if (v === null || v === undefined) return fallback;
	const n = Number(v);
	return isNaN(n) ? fallback : n;
}

// ─── Per-engine collectors ────────────────────────────────────────────────────

async function collectPostgres(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	const slowThresholdSec = HEALTH_THRESHOLDS.slowQueryThresholdMs / 1000;

	const [connRows, dbRows, cacheRows, connStateRows, slowRows] = await Promise.all([
		// Max connections setting
		trySql(config, `SELECT setting::int AS max_conn FROM pg_settings WHERE name = 'max_connections'`),
		// Per-database TPS stats and size for current DB only
		trySql(config, `
			SELECT
				xact_commit      AS commits,
				xact_rollback    AS rollbacks,
				pg_database_size(current_database()) AS db_size_bytes
			FROM pg_stat_database
			WHERE datname = current_database()`),
		// Cache hit ratio via pg_statio_user_tables (works on all PG versions)
		trySql(config, `
			SELECT
				(SUM(heap_blks_hit)::float / NULLIF(SUM(heap_blks_hit) + SUM(heap_blks_read), 0)) * 100
					AS cache_hit_ratio
			FROM pg_statio_user_tables`),
		// Connection state counts — pure aggregates, no mixed GROUP BY
		trySql(config, `
			SELECT
				COUNT(*) FILTER (WHERE state = 'active')  AS active,
				COUNT(*) FILTER (WHERE state = 'idle')    AS idle,
				COUNT(*) FILTER (WHERE state IN ('idle in transaction', 'idle in transaction (aborted)'))
					AS waiting
			FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()`),
		// Slow queries — one row per running query
		trySql(config, `
			SELECT
				query,
				usename,
				datname,
				state,
				EXTRACT(EPOCH FROM (now() - query_start))::int AS dur_sec
			FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()
				AND state = 'active'
				AND query_start IS NOT NULL
				AND EXTRACT(EPOCH FROM (now() - query_start)) >= ${slowThresholdSec}
			ORDER BY query_start ASC
			LIMIT 20`)
	]);

	const maxConn = num(connRows[0]?.max_conn, 100);
	const commits = num(dbRows[0]?.commits);
	const rollbacks = num(dbRows[0]?.rollbacks);
	const totalSizeBytes = num(dbRows[0]?.db_size_bytes);
	const cacheHit = cacheRows[0]?.cache_hit_ratio != null
		? Math.round(num(cacheRows[0].cache_hit_ratio) * 10) / 10
		: null;

	const connections: DBHealthConnections = {
		active: num(connStateRows[0]?.active),
		idle: num(connStateRows[0]?.idle),
		waiting: num(connStateRows[0]?.waiting),
		max: maxConn
	};

	const tps: DBHealthTPS = { commits, rollbacks, tps: 0 };

	const memory: DBHealthMemory = {
		usedMb: 0,
		totalMb: null,
		cacheHitRatio: cacheHit
	};

	const disk: DBHealthDisk = { dbSizeMb: Math.round(totalSizeBytes / 1024 / 1024 * 10) / 10 };

	const slowQueries: DBSlowQuery[] = slowRows.map((r) => ({
		query: String(r['query'] ?? ''),
		durationMs: num(r['dur_sec']) * 1000,
		user: r['usename'] ? String(r['usename']) : undefined,
		database: r['datname'] ? String(r['datname']) : undefined,
		state: r['state'] ? String(r['state']) : undefined
	}));

	return { timestamp: new Date().toISOString(), dbType: config.type, connections, tps, memory, disk, slowQueries };
}

async function collectMySQL(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	const slowThresholdSec = Math.ceil(HEALTH_THRESHOLDS.slowQueryThresholdMs / 1000);

	const [statusRows, connRows, procRows] = await Promise.all([
		trySql(config, `SHOW GLOBAL STATUS`),
		trySql(config, `SHOW VARIABLES LIKE 'max_connections'`),
		trySql(config, `
			SELECT id, user, db, command, time, info
			FROM information_schema.PROCESSLIST
			WHERE command <> 'Sleep' AND time >= ${slowThresholdSec}
			ORDER BY time DESC LIMIT 20`)
	]);

	// Build a map of all status variables (case-insensitive key lookup)
	const statusMap: Record<string, number> = {};
	for (const r of statusRows) {
		const key = String(r['Variable_name'] ?? r['variable_name'] ?? '');
		const val = r['Value'] ?? r['value'];
		statusMap[key] = num(val);
	}

	const maxConn = connRows[0]
		? num(connRows[0]['Value'] ?? connRows[0]['value'], 151)
		: 151;

	const bufferPoolData = statusMap['Innodb_buffer_pool_bytes_data'] ?? 0;
	const readReq = statusMap['Innodb_buffer_pool_read_requests'] ?? 0;
	const reads = statusMap['Innodb_buffer_pool_reads'] ?? 0;
	const cacheHitRatio = readReq > 0 ? Math.round(((readReq - reads) / readReq) * 1000) / 10 : null;

	const connections: DBHealthConnections = {
		active: statusMap['Threads_running'] ?? 0,
		idle: Math.max(0, (statusMap['Threads_connected'] ?? 0) - (statusMap['Threads_running'] ?? 0)),
		waiting: 0,
		max: maxConn
	};

	const tps: DBHealthTPS = {
		commits: statusMap['Com_commit'] ?? 0,
		rollbacks: statusMap['Com_rollback'] ?? 0,
		tps: 0
	};

	const memory: DBHealthMemory = {
		usedMb: Math.round(bufferPoolData / 1024 / 1024 * 10) / 10,
		totalMb: null,
		cacheHitRatio
	};

	const slowQueries: DBSlowQuery[] = procRows
		.filter((r) => {
			const info = String(r['info'] ?? r['Info'] ?? '').trim();
			return info.length > 0 && info !== 'NULL';
		})
		.map((r) => ({
			query: String(r['info'] ?? r['Info'] ?? ''),
			durationMs: num(r['time'] ?? r['Time']) * 1000,
			user: r['user'] ? String(r['user']) : undefined,
			database: r['db'] ? String(r['db']) : undefined
		}));

	return { timestamp: new Date().toISOString(), dbType: config.type, connections, tps, memory, disk: null, slowQueries };
}

async function collectMSSQL(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	const [perfRows, reqRows, memRows, sizeRows] = await Promise.all([
		trySql(config, `
			SELECT RTRIM(counter_name) AS counter_name, cntr_value
			FROM sys.dm_os_performance_counters
			WHERE RTRIM(counter_name) IN (
				'User Connections',
				'Batch Requests/sec',
				'Transactions/sec'
			) AND instance_name IN ('', '_Total')`),
		trySql(config, `
			SELECT r.session_id, s.login_name, DB_NAME(r.database_id) AS db_name,
				r.status, r.total_elapsed_time, t.text
			FROM sys.dm_exec_requests r
			JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
			CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
			WHERE r.session_id <> @@SPID AND r.total_elapsed_time >= ${HEALTH_THRESHOLDS.slowQueryThresholdMs}
			ORDER BY r.total_elapsed_time DESC`),
		trySql(config, `
			SELECT physical_memory_in_use_kb / 1024.0 AS used_mb
			FROM sys.dm_os_process_memory`),
		trySql(config, `
			SELECT SUM(size * 8.0 / 1024) AS size_mb
			FROM sys.master_files WHERE database_id = DB_ID()`)
	]);

	const perfMap: Record<string, number> = {};
	for (const r of perfRows) {
		perfMap[String(r['counter_name'] ?? '').trim()] = num(r['cntr_value']);
	}

	const connections: DBHealthConnections = {
		active: perfMap['User Connections'] ?? 0,
		idle: 0,
		waiting: 0,
		max: null
	};

	const tps: DBHealthTPS = {
		commits: perfMap['Transactions/sec'] ?? 0,
		rollbacks: 0,
		tps: 0
	};

	const memory: DBHealthMemory = {
		usedMb: Math.round(num(memRows[0]?.used_mb) * 10) / 10,
		totalMb: null,
		cacheHitRatio: null
	};

	const disk: DBHealthDisk | null = sizeRows[0]
		? { dbSizeMb: Math.round(num(sizeRows[0]['size_mb']) * 10) / 10 }
		: null;

	const slowQueries: DBSlowQuery[] = reqRows.map((r) => ({
		query: String(r['text'] ?? ''),
		durationMs: num(r['total_elapsed_time']),
		user: r['login_name'] ? String(r['login_name']) : undefined,
		database: r['db_name'] ? String(r['db_name']) : undefined,
		state: r['status'] ? String(r['status']) : undefined
	}));

	return { timestamp: new Date().toISOString(), dbType: config.type, connections, tps, memory, disk, slowQueries };
}

async function collectSQLite(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	let dbSizeMb = 0;
	if (config.path) {
		try {
			const file = Bun.file(config.path);
			dbSizeMb = Math.round(file.size / 1024 / 1024 * 100) / 100;
		} catch { /* file not accessible */ }
	}

	return {
		timestamp: new Date().toISOString(),
		dbType: 'sqlite',
		connections: { active: 1, idle: 0, waiting: 0, max: 1 },
		tps: null,
		memory: null,
		disk: { dbSizeMb },
		slowQueries: []
	};
}

async function collectMongoDB(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	const { MongoDBAdapter } = await import('./mongodb-adapter');
	const adapter = new MongoDBAdapter(config);
	const result = await (adapter as any).executeQuery('db.runCommand({ serverStatus: 1 })');
	if (result.error || !result.rows.length) {
		throw new Error(result.error ?? 'No serverStatus data');
	}
	const status = result.rows[0] as Record<string, any>;
	const connStats = status['connections'] ?? {};
	const opStats = status['opcounters'] ?? {};
	const memStats = status['mem'] ?? {};

	const connections: DBHealthConnections = {
		active: num(connStats['current']),
		idle: Math.max(0, num(connStats['available']) - num(connStats['current'])),
		waiting: 0,
		max: num(connStats['available']) || null
	};

	const totalOps = num(opStats['insert']) + num(opStats['query']) + num(opStats['update']) + num(opStats['delete']);
	const tps: DBHealthTPS = { commits: totalOps, rollbacks: 0, tps: 0 };

	const memory: DBHealthMemory = {
		usedMb: num(memStats['resident']),
		totalMb: num(memStats['virtual']) || null,
		cacheHitRatio: null
	};

	return { timestamp: new Date().toISOString(), dbType: 'mongodb', connections, tps, memory, disk: null, slowQueries: [] };
}

async function collectRedis(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	const { RedisAdapter } = await import('./redis-adapter');
	const adapter = new RedisAdapter(config);
	const result = await (adapter as any).executeQuery('INFO all');
	if (result.error) throw new Error(result.error);

	// Parse the INFO output (key:value lines)
	const infoMap: Record<string, string> = {};
	const raw = String(result.rows[0]?.info ?? result.rows[0]?.result ?? '');
	for (const line of raw.split('\n')) {
		const idx = line.indexOf(':');
		if (idx > 0) infoMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}

	const connections: DBHealthConnections = {
		active: num(infoMap['connected_clients']),
		idle: 0,
		waiting: num(infoMap['blocked_clients']),
		max: num(infoMap['maxclients']) || null
	};

	const cmdsSec = num(infoMap['instantaneous_ops_per_sec']);
	const tps: DBHealthTPS = { commits: 0, rollbacks: 0, tps: cmdsSec };

	const usedMb = num(infoMap['used_memory']) / 1024 / 1024;
	const maxMem = num(infoMap['maxmemory']);
	const memory: DBHealthMemory = {
		usedMb: Math.round(usedMb * 10) / 10,
		totalMb: maxMem > 0 ? Math.round(maxMem / 1024 / 1024 * 10) / 10 : null,
		cacheHitRatio: null
	};

	return { timestamp: new Date().toISOString(), dbType: 'redis', connections, tps, memory, disk: null, slowQueries: [] };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function collectHealthMetrics(config: DBConnectionConfig): Promise<DBHealthMetrics> {
	return withSSHTunnel(config, async (c) => {
		switch (c.type) {
			case 'postgresql': return collectPostgres(c);
			case 'mysql':
			case 'mariadb': return collectMySQL(c);
			case 'mssql': return collectMSSQL(c);
			case 'sqlite': return collectSQLite(c);
			case 'mongodb': return collectMongoDB(c);
			case 'redis': return collectRedis(c);
			default: throw new Error(`Health metrics not supported for ${(c as any).type}`);
		}
	});
}
