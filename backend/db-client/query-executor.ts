/**
 * db-client — query classification + safe-execute helpers.
 *
 * `runSafely` applies auto-LIMIT 500 to bare SELECT/WITH reads.
 */

import type {
	DbClientQueryResult,
	DbDriver
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './drivers/types';

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

	if (mode === 'read' && (driver === 'mysql' || driver === 'postgres' || driver === 'sqlite')) {
		query = applyAutoLimit(query, limit ?? 500);
	}

	const fn = mode === 'read' ? adapter.executeRead : adapter.executeWrite;
	if (!fn) throw new Error(`Driver ${driver} does not support ${mode}`);
	return fn.call(adapter, query, params, { database });
}
