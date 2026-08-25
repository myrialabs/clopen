/**
 * Frontend query classifier — mirror of backend `classifyQuery` for the UI badge.
 */

import type { DbDriver } from '$shared/types/db-client';

export type QueryClass = 'read' | 'write' | 'ddl' | 'unknown';

const SQL_READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'PRAGMA']);
const SQL_WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT']);
const SQL_DDL = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE']);
const MONGO_READ = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);
const REDIS_READ = new Set([
	'GET', 'MGET', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN',
	'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN',
	'LRANGE', 'LLEN', 'LINDEX',
	'SMEMBERS', 'SISMEMBER', 'SCARD',
	'ZRANGE', 'ZRANGEBYSCORE', 'ZRANK', 'ZSCORE', 'ZCARD',
	'PING', 'INFO', 'DBSIZE', 'CLIENT'
]);

function firstKw(query: string): string {
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
	const m = /^([A-Za-z]+)/.exec(query.slice(i));
	return m ? m[1].toUpperCase() : '';
}

export function classifyQuery(driver: DbDriver, query: string): QueryClass {
	if (driver === 'mongodb') {
		try {
			const parsed = JSON.parse(query) as { op?: string };
			if (parsed.op && MONGO_READ.has(parsed.op)) return 'read';
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
				if (Array.isArray(parsed) && parsed.length > 0) cmd = String(parsed[0]).toUpperCase();
				else return 'unknown';
			} catch {
				return 'unknown';
			}
		} else {
			cmd = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
		}
		if (!cmd) return 'unknown';
		return REDIS_READ.has(cmd) ? 'read' : 'write';
	}
	const kw = firstKw(query);
	if (!kw) return 'unknown';
	if (SQL_READ.has(kw)) return 'read';
	if (SQL_WRITE.has(kw)) return 'write';
	if (SQL_DDL.has(kw)) return 'ddl';
	return 'unknown';
}

export function languageForDriver(driver: DbDriver): string {
	switch (driver) {
		case 'mysql':
		case 'postgres':
		case 'sqlite':
		case 'mssql':
			return 'sql';
		case 'mongodb':
			return 'json';
		case 'redis':
			return 'shell';
		default:
			return 'sql';
	}
}
