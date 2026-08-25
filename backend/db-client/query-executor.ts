/**
 * db-client — query classification + safe-execute helpers.
 *
 * `runSafely` applies auto-LIMIT 500 to bare SELECT/WITH reads.
 */

import type {
	DbClientBatchResult,
	DbClientQueryResult,
	DbClientStatementResult,
	DbDriver
} from '$shared/types/db-client';
import type { DbClientDriverAdapter, DbClientTxContext } from './drivers/types';

export type QueryClass = 'read' | 'write' | 'ddl' | 'unknown';

const SQL_READ_TOKENS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'PRAGMA']);
const SQL_WRITE_TOKENS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT']);
const SQL_DDL_TOKENS = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE']);

const MONGO_READ_OPS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);
const REDIS_READ_CMDS = new Set([
	'GET', 'MGET', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN',
	'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN',
	'LRANGE', 'LLEN', 'LINDEX',
	'SMEMBERS', 'SISMEMBER', 'SCARD',
	'ZRANGE', 'ZRANGEBYSCORE', 'ZRANK', 'ZSCORE', 'ZCARD',
	'PING', 'INFO', 'DBSIZE', 'CLIENT'
]);

function firstSqlKeyword(query: string): string {
	let i = 0;
	while (i < query.length) {
		const ch = query[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++;
		} else if (ch === '-' && query[i + 1] === '-') {
			const nl = query.indexOf('\n', i);
			if (nl === -1) return '';
			i = nl + 1;
		} else if (ch === '/' && query[i + 1] === '*') {
			const end = query.indexOf('*/', i + 2);
			if (end === -1) return '';
			i = end + 2;
		} else {
			break;
		}
	}
	const rest = query.slice(i);
	const match = /^([A-Za-z]+)/.exec(rest);
	return match ? match[1].toUpperCase() : '';
}

export function classifyQuery(driver: DbDriver, query: string): QueryClass {
	if (driver === 'mongodb') {
		try {
			const parsed = JSON.parse(query) as { op?: string };
			if (parsed.op && MONGO_READ_OPS.has(parsed.op)) return 'read';
			if (parsed.op) return 'write';
		} catch {
			return 'unknown';
		}
		return 'unknown';
	}

	if (driver === 'redis') {
		const trimmed = query.trim();
		let cmd: string;
		if (trimmed.startsWith('[')) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (Array.isArray(parsed) && parsed.length > 0) {
					cmd = String(parsed[0]).toUpperCase();
				} else {
					return 'unknown';
				}
			} catch {
				return 'unknown';
			}
		} else {
			cmd = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
		}
		if (!cmd) return 'unknown';
		return REDIS_READ_CMDS.has(cmd) ? 'read' : 'write';
	}

	const kw = firstSqlKeyword(query);
	if (!kw) return 'unknown';
	if (SQL_READ_TOKENS.has(kw)) return 'read';
	if (SQL_WRITE_TOKENS.has(kw)) return 'write';
	if (SQL_DDL_TOKENS.has(kw)) return 'ddl';
	return 'unknown';
}

/**
 * Append `LIMIT n` to a SELECT/WITH query that does not already specify
 * one. Conservative — only touches plain SQL reads.
 */
export function applyAutoLimit(query: string, limit = 500): string {
	const trimmed = query.replace(/;\s*$/, '');
	const kw = firstSqlKeyword(trimmed);
	if (kw !== 'SELECT' && kw !== 'WITH') return query;
	if (/\blimit\s+\d+/i.test(trimmed)) return query;
	return `${trimmed} LIMIT ${limit}`;
}

/**
 * SQL Server has no `LIMIT`; the equivalent cap is `TOP (n)` right after the
 * `SELECT` keyword. Conservative — only touches a plain leading `SELECT`
 * (skips `WITH`/CTE where TOP placement is ambiguous) and leaves queries that
 * already cap or page (`TOP`, `OFFSET … ROWS`) untouched.
 */
export function applyAutoLimitMssql(query: string, limit = 500): string {
	const trimmed = query.replace(/;\s*$/, '');
	if (firstSqlKeyword(trimmed) !== 'SELECT') return query;
	if (/\boffset\s+\d+\s+rows?\b/i.test(trimmed)) return query;

	// Locate the leading SELECT token, skipping whitespace and comments.
	let i = 0;
	while (i < trimmed.length) {
		const ch = trimmed[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++;
		} else if (ch === '-' && trimmed[i + 1] === '-') {
			const nl = trimmed.indexOf('\n', i);
			if (nl === -1) return query;
			i = nl + 1;
		} else if (ch === '/' && trimmed[i + 1] === '*') {
			const end = trimmed.indexOf('*/', i + 2);
			if (end === -1) return query;
			i = end + 2;
		} else {
			break;
		}
	}
	const after = trimmed.slice(i);
	const m = /^select\s+(distinct\s+|all\s+)?/i.exec(after);
	if (!m) return query;
	if (/^top\b/i.test(after.slice(m[0].length))) return query;
	const insertAt = i + m[0].length;
	return `${trimmed.slice(0, insertAt)}TOP (${limit}) ${trimmed.slice(insertAt)}`;
}

/** Apply the driver-appropriate auto-limit to a read query (no-op for drivers without one). */
function autoLimitForDriver(driver: DbDriver, query: string, limit: number): string {
	if (driver === 'mysql' || driver === 'postgres' || driver === 'sqlite') return applyAutoLimit(query, limit);
	if (driver === 'mssql') return applyAutoLimitMssql(query, limit);
	return query;
}

interface RunSafelyInput {
	driver: DbDriver;
	adapter: DbClientDriverAdapter;
	query: string;
	params?: unknown[];
	mode: 'read' | 'write';
	database?: string;
	limit?: number;
}

export async function runSafely(input: RunSafelyInput): Promise<DbClientQueryResult> {
	const { adapter, driver, mode, params, database, limit } = input;
	let query = input.query;

	if (mode === 'read') {
		query = autoLimitForDriver(driver, query, limit ?? 500);
	}

	const fn = mode === 'read' ? adapter.executeRead : adapter.executeWrite;
	if (!fn) throw new Error(`Driver ${driver} does not support ${mode}`);
	return fn.call(adapter, query, params, { database });
}

interface ExecuteBatchInput {
	driver: DbDriver;
	adapter: DbClientDriverAdapter;
	statements: string[];
	params?: unknown[];
	database?: string;
	limit?: number;
}

function skippedStatement(index: number, query: string, queryClass: QueryClass): DbClientStatementResult {
	return { index, query, queryClass, status: 'skipped', result: null, error: null, durationMs: 0 };
}

/**
 * Execute a pre-split batch of statements in order. Each statement is
 * classified individually and routed to read (auto-LIMITed) or write
 * execution accordingly — the classification of the whole batch never lets a
 * write ride in on the read path. When the driver supports transactions the
 * batch is atomic: the first failure rolls the whole batch back and every
 * later statement is reported as `skipped`.
 */
export async function executeBatch(input: ExecuteBatchInput): Promise<DbClientBatchResult> {
	const { driver, adapter, statements, params, database, limit } = input;

	const runAll = async (exec: DbClientTxContext): Promise<{ results: DbClientStatementResult[]; totalDurationMs: number; failed: boolean }> => {
		const results: DbClientStatementResult[] = [];
		let totalDurationMs = 0;
		let failed = false;
		for (let index = 0; index < statements.length; index++) {
			const query = statements[index];
			const queryClass = classifyQuery(driver, query);
			if (failed) {
				results.push(skippedStatement(index, query, queryClass));
				continue;
			}
			try {
				const result = queryClass === 'read'
					? await exec.executeRead(autoLimitForDriver(driver, query, limit ?? 500), params, { database })
					: await exec.executeWrite(query, params, { database });
				totalDurationMs += result.durationMs;
				results.push({ index, query, queryClass, status: 'success', result, error: null, durationMs: result.durationMs });
			} catch (err) {
				failed = true;
				results.push({
					index,
					query,
					queryClass,
					status: 'error',
					result: null,
					error: err instanceof Error ? err.message : String(err),
					durationMs: 0
				});
			}
		}
		return { results, totalDurationMs, failed };
	};

	if (typeof adapter.withTransaction === 'function' && statements.length > 1) {
		let captured: { results: DbClientStatementResult[]; totalDurationMs: number; failed: boolean } | null = null;
		try {
			await adapter.withTransaction(async (tx) => {
				captured = await runAll(tx);
				// Throw to force a rollback while preserving the per-statement report.
				if (captured.failed) throw new BatchRollbackSignal();
			}, { database });
		} catch (err) {
			if (!(err instanceof BatchRollbackSignal)) throw err;
		}
		// `captured` is always assigned unless withTransaction never ran the
		// callback (which would have thrown a non-signal error above).
		const c = captured as unknown as { results: DbClientStatementResult[]; totalDurationMs: number; failed: boolean };
		return { statements: c.results, totalDurationMs: c.totalDurationMs, transaction: true, ok: !c.failed };
	}

	// Non-transactional fallback: statements run sequentially and independently.
	const direct: DbClientTxContext = {
		executeRead: (q, p, o) => runSafely({ driver, adapter, query: q, params: p, mode: 'read', database: o?.database, limit: o?.limit }),
		executeWrite: (q, p, o) => runSafely({ driver, adapter, query: q, params: p, mode: 'write', database: o?.database })
	};
	const { results, totalDurationMs, failed } = await runAll(direct);
	return { statements: results, totalDurationMs, transaction: false, ok: !failed };
}

/** Internal sentinel: thrown to trigger a transaction rollback on batch failure. */
class BatchRollbackSignal extends Error {}
