/**
 * db-client — import/export WS handlers.
 *
 * Export builds a single combined file in the requested format,
 * sending it back as a string for the client to download.
 *
 * Import parses a single uploaded file in the requested format and
 * applies it to the connection (DDL/INSERT for SQL drivers, insertMany
 * for mongodb, SET/HSET/etc for redis).
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import { dbClientConnectionQueries } from '../../database/queries';
import type { DbClientObjectDetails, DbClientQueryResult } from '$shared/types/db-client';

type SqlDriver = 'mysql' | 'postgres' | 'sqlite';

function quoteIdent(driver: SqlDriver, name: string): string {
	if (driver === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
	return '"' + name.replace(/"/g, '""') + '"';
}

function qualified(driver: SqlDriver, parts: Array<string | undefined>): string {
	return parts.filter((p): p is string => Boolean(p)).map((p) => quoteIdent(driver, p)).join('.');
}

function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (v instanceof Date) return `'${v.toISOString()}'`;
	if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
	return `'${String(v).replace(/'/g, "''")}'`;
}

function csvCell(v: unknown): string {
	if (v === null || v === undefined) return '';
	const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
	const rows: string[][] = [];
	let field = '';
	let row: string[] = [];
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (ch === '"') inQuotes = false;
			else field += ch;
		} else {
			if (ch === '"') inQuotes = true;
			else if (ch === ',') { row.push(field); field = ''; }
			else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
			else if (ch === '\r') { /* skip */ }
			else field += ch;
		}
	}
	if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
	const headers = rows.shift() ?? [];
	return { headers, rows };
}

function splitSqlStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = '';
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			buf += ch;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') { inBlockComment = false; buf += '*/'; i++; continue; }
			buf += ch;
			continue;
		}
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === '-' && next === '-') { inLineComment = true; buf += '--'; i++; continue; }
			if (ch === '/' && next === '*') { inBlockComment = true; buf += '/*'; i++; continue; }
		}
		if (!inDouble && !inBacktick && ch === "'" && sql[i - 1] !== '\\') inSingle = !inSingle;
		else if (!inSingle && !inBacktick && ch === '"' && sql[i - 1] !== '\\') inDouble = !inDouble;
		else if (!inSingle && !inDouble && ch === '`') inBacktick = !inBacktick;
		if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
			const trimmed = buf.trim();
			if (trimmed.length > 0) out.push(trimmed);
			buf = '';
		} else {
			buf += ch;
		}
	}
	const tail = buf.trim();
	if (tail.length > 0) out.push(tail);
	return out;
}

async function readAllRows(connectionId: string, driver: SqlDriver, table: string, database?: string, schema?: string): Promise<DbClientQueryResult> {
	const adapter = await connectionManager.get(connectionId);
	if (!adapter.executeRead) throw new Error('executeRead not supported');
	const fqt = qualified(driver, [database, schema, table]);
	return adapter.executeRead(`SELECT * FROM ${fqt}`, [], { database, limit: 1_000_000 });
}

async function getColumns(connectionId: string, driver: 'mysql' | 'postgres' | 'sqlite' | 'mongodb', table: string, database?: string, schema?: string): Promise<DbClientObjectDetails> {
	const adapter = await connectionManager.get(connectionId);
	if (!adapter.getObjectDetails) throw new Error('getObjectDetails not supported');
	return adapter.getObjectDetails(table, driver === 'mongodb' ? 'collection' : 'table', database, schema);
}

function buildCreateTableSql(driver: SqlDriver, details: DbClientObjectDetails, tableName: string, database?: string, schema?: string): string {
	const cols = details.columns ?? [];
	const fqt = qualified(driver, [database, schema, tableName]);
	const lines: string[] = [];
	for (const c of cols) {
		const parts = [quoteIdent(driver, c.name), c.type];
		if (!c.nullable) parts.push('NOT NULL');
		if (c.default !== null && c.default !== undefined && c.default !== '') parts.push(`DEFAULT ${c.default}`);
		if (c.isPrimary) parts.push('PRIMARY KEY');
		if (c.isUnique && !c.isPrimary) parts.push('UNIQUE');
		lines.push('  ' + parts.join(' '));
	}
	return `CREATE TABLE ${fqt} (\n${lines.join(',\n')}\n);`;
}

export const ioHandler = createRouter()
	.http('db-client:data:export', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			tables: t.Array(t.String({ minLength: 1 })),
			format: t.Union([
				t.Literal('sql'), t.Literal('csv'), t.Literal('json'),
				t.Literal('jsonl'), t.Literal('redis')
			]),
			withData: t.Optional(t.Boolean()),
			schemaOnly: t.Optional(t.Boolean())
		}),
		response: t.Object({
			filename: t.String(),
			content: t.String(),
			mimeType: t.String()
		})
	}, async ({ data }) => {
		const conn = dbClientConnectionQueries.get(data.connectionId);
		if (!conn) throw new Error('connection not found');
		const driver = conn.driver;
		const withData = data.schemaOnly ? false : (data.withData ?? true);

		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const baseName = data.tables.length === 1 ? data.tables[0] : `export-${data.tables.length}-tables`;

		if (driver === 'mysql' || driver === 'postgres' || driver === 'sqlite') {
			const sqlDriver = driver as SqlDriver;
			if (data.format === 'sql') {
				const parts: string[] = [];
				for (const t of data.tables) {
					const details = await getColumns(data.connectionId, sqlDriver, t, data.database, data.schema);
					parts.push(`-- Table: ${t}`);
					parts.push(buildCreateTableSql(sqlDriver, details, t, data.database, data.schema));
					if (withData) {
						const result = await readAllRows(data.connectionId, sqlDriver, t, data.database, data.schema);
						const cols = result.columns.map((c) => c.name);
						const fqt = qualified(sqlDriver, [data.database, data.schema, t]);
						const colSql = cols.map((c) => quoteIdent(sqlDriver, c)).join(', ');
						for (const row of result.rows) {
							const vals = cols.map((c) => sqlLiteral(row[c])).join(', ');
							parts.push(`INSERT INTO ${fqt} (${colSql}) VALUES (${vals});`);
						}
					}
					parts.push('');
				}
				return {
					filename: `${baseName}-${stamp}.sql`,
					content: parts.join('\n'),
					mimeType: 'application/sql'
				};
			}
			if (data.format === 'csv') {
				if (data.tables.length !== 1) throw new Error('CSV export supports a single table only');
				const t = data.tables[0];
				const result = await readAllRows(data.connectionId, sqlDriver, t, data.database, data.schema);
				const cols = result.columns.map((c) => c.name);
				const lines: string[] = [cols.map(csvCell).join(',')];
				for (const row of result.rows) {
					lines.push(cols.map((c) => csvCell(row[c])).join(','));
				}
				return {
					filename: `${baseName}-${stamp}.csv`,
					content: lines.join('\n'),
					mimeType: 'text/csv'
				};
			}
			if (data.format === 'json') {
				const out: Record<string, unknown[]> = {};
				for (const t of data.tables) {
					if (!withData) { out[t] = []; continue; }
					const result = await readAllRows(data.connectionId, sqlDriver, t, data.database, data.schema);
					out[t] = result.rows;
				}
				return {
					filename: `${baseName}-${stamp}.json`,
					content: JSON.stringify(out, null, 2),
					mimeType: 'application/json'
				};
			}
			throw new Error(`Format ${data.format} not supported for ${driver}`);
		}

		if (driver === 'mongodb') {
			const adapter = await connectionManager.get(data.connectionId);
			if (data.format === 'json' || data.format === 'jsonl') {
				const out: Record<string, unknown[]> = {};
				for (const coll of data.tables) {
					if (!withData) { out[coll] = []; continue; }
					const q = JSON.stringify({
						collection: coll,
						op: 'find',
						args: [{}, { limit: 1_000_000 }]
					});
					if (!adapter.executeRead) throw new Error('executeRead not supported');
					const result = await adapter.executeRead(q, [], { database: data.database });
					out[coll] = result.rows;
				}
				if (data.format === 'jsonl') {
					if (data.tables.length !== 1) throw new Error('JSONL export supports a single collection only');
					const docs = out[data.tables[0]] ?? [];
					return {
						filename: `${baseName}-${stamp}.jsonl`,
						content: docs.map((d) => JSON.stringify(d)).join('\n'),
						mimeType: 'application/x-ndjson'
					};
				}
				return {
					filename: `${baseName}-${stamp}.json`,
					content: JSON.stringify(out, null, 2),
					mimeType: 'application/json'
				};
			}
			throw new Error(`Format ${data.format} not supported for mongodb`);
		}

		if (driver === 'redis') {
			const adapter = await connectionManager.get(data.connectionId);
			if (!adapter.executeRead || !adapter.executeWrite) throw new Error('redis exec not supported');
			interface KeyEntry { key: string; type: string; ttl: number | null; value: unknown }
			const entries: KeyEntry[] = [];
			for (const key of data.tables) {
				const typeRes = await adapter.executeRead(JSON.stringify(['TYPE', key]), [], {});
				const ttlRes = await adapter.executeRead(JSON.stringify(['TTL', key]), [], {});
				const type = (typeRes.rows[0] as { result?: string } | undefined)?.result ?? 'string';
				const ttl = ((ttlRes.rows[0] as { result?: number } | undefined)?.result ?? -1) > 0
					? (ttlRes.rows[0] as { result?: number }).result ?? null
					: null;
				let cmd: unknown[];
				switch (type) {
					case 'list': cmd = ['LRANGE', key, '0', '-1']; break;
					case 'hash': cmd = ['HGETALL', key]; break;
					case 'set': cmd = ['SMEMBERS', key]; break;
					case 'zset': cmd = ['ZRANGE', key, '0', '-1', 'WITHSCORES']; break;
					default: cmd = ['GET', key];
				}
				const valRes = await adapter.executeRead(JSON.stringify(cmd), [], {});
				const value = (valRes.rows[0] as { result?: unknown } | undefined)?.result ?? null;
				entries.push({ key, type, ttl, value });
			}
			if (data.format === 'json') {
				const out: Record<string, { type: string; ttl: number | null; value: unknown }> = {};
				for (const e of entries) out[e.key] = { type: e.type, ttl: e.ttl, value: e.value };
				return {
					filename: `${baseName}-${stamp}.json`,
					content: JSON.stringify(out, null, 2),
					mimeType: 'application/json'
				};
			}
			if (data.format === 'redis') {
				const lines: string[] = [];
				for (const e of entries) {
					switch (e.type) {
						case 'string': lines.push(`SET ${e.key} ${JSON.stringify(String(e.value ?? ''))}`); break;
						case 'list': {
							const arr = Array.isArray(e.value) ? e.value : [];
							if (arr.length > 0) lines.push(`RPUSH ${e.key} ${arr.map((v) => JSON.stringify(String(v))).join(' ')}`);
							break;
						}
						case 'hash': {
							const obj = (typeof e.value === 'object' && e.value !== null) ? e.value as Record<string, unknown> : {};
							const pairs = Object.entries(obj).flatMap(([k, v]) => [k, String(v)]);
							if (pairs.length > 0) lines.push(`HSET ${e.key} ${pairs.map((p) => JSON.stringify(p)).join(' ')}`);
							break;
						}
						case 'set': {
							const arr = Array.isArray(e.value) ? e.value : [];
							if (arr.length > 0) lines.push(`SADD ${e.key} ${arr.map((v) => JSON.stringify(String(v))).join(' ')}`);
							break;
						}
						default: break;
					}
					if (e.ttl && e.ttl > 0) lines.push(`EXPIRE ${e.key} ${e.ttl}`);
				}
				return {
					filename: `${baseName}-${stamp}.redis`,
					content: lines.join('\n'),
					mimeType: 'text/plain'
				};
			}
			throw new Error(`Format ${data.format} not supported for redis`);
		}

		throw new Error(`Driver ${driver} not supported`);
	})

	.http('db-client:data:import', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			format: t.Union([
				t.Literal('sql'), t.Literal('csv'), t.Literal('json'),
				t.Literal('jsonl'), t.Literal('redis')
			]),
			content: t.String(),
			targetTable: t.Optional(t.String())
		}),
		response: t.Object({
			ok: t.Boolean(),
			count: t.Number(),
			message: t.String()
		})
	}, async ({ data }) => {
		const conn = dbClientConnectionQueries.get(data.connectionId);
		if (!conn) throw new Error('connection not found');
		const driver = conn.driver;
		const adapter = await connectionManager.get(data.connectionId);

		if (driver === 'mysql' || driver === 'postgres' || driver === 'sqlite') {
			if (data.format === 'sql') {
				const stmts = splitSqlStatements(data.content);
				let count = 0;
				for (const s of stmts) {
					if (!adapter.executeWrite) throw new Error('executeWrite not supported');
					await adapter.executeWrite(s, [], { database: data.database });
					count++;
				}
				return { ok: true, count, message: `Executed ${count} statement(s)` };
			}
			if (data.format === 'json') {
				const parsed = JSON.parse(data.content) as Record<string, Record<string, unknown>[]>;
				let total = 0;
				for (const [table, rows] of Object.entries(parsed)) {
					if (!Array.isArray(rows) || rows.length === 0) continue;
					if (!adapter.insertRow) throw new Error('insertRow not supported');
					for (const row of rows) {
						await adapter.insertRow(table, row, { database: data.database, schema: data.schema });
						total++;
					}
				}
				return { ok: true, count: total, message: `Inserted ${total} row(s)` };
			}
			if (data.format === 'csv') {
				if (!data.targetTable) throw new Error('CSV import requires targetTable');
				const { headers, rows } = parseCsv(data.content);
				if (!adapter.insertRow) throw new Error('insertRow not supported');
				let count = 0;
				for (const row of rows) {
					if (row.every((v) => v === '')) continue;
					const obj: Record<string, unknown> = {};
					for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? '';
					await adapter.insertRow(data.targetTable, obj, { database: data.database, schema: data.schema });
					count++;
				}
				return { ok: true, count, message: `Inserted ${count} row(s) into ${data.targetTable}` };
			}
			throw new Error(`Format ${data.format} not supported for ${driver}`);
		}

		if (driver === 'mongodb') {
			if (data.format === 'json') {
				const parsed = JSON.parse(data.content) as Record<string, unknown[]>;
				let total = 0;
				if (!adapter.insertRow) throw new Error('insertRow not supported');
				for (const [coll, docs] of Object.entries(parsed)) {
					if (!Array.isArray(docs)) continue;
					for (const doc of docs) {
						await adapter.insertRow(coll, doc as Record<string, unknown>, { database: data.database });
						total++;
					}
				}
				return { ok: true, count: total, message: `Inserted ${total} document(s)` };
			}
			if (data.format === 'jsonl') {
				if (!data.targetTable) throw new Error('JSONL import requires targetTable');
				const lines = data.content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
				if (!adapter.insertRow) throw new Error('insertRow not supported');
				let count = 0;
				for (const line of lines) {
					const doc = JSON.parse(line) as Record<string, unknown>;
					await adapter.insertRow(data.targetTable, doc, { database: data.database });
					count++;
				}
				return { ok: true, count, message: `Inserted ${count} document(s) into ${data.targetTable}` };
			}
			throw new Error(`Format ${data.format} not supported for mongodb`);
		}

		if (driver === 'redis') {
			if (!adapter.executeWrite) throw new Error('executeWrite not supported');
			if (data.format === 'redis') {
				const lines = data.content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
				let count = 0;
				for (const line of lines) {
					await adapter.executeWrite(line, [], {});
					count++;
				}
				return { ok: true, count, message: `Executed ${count} command(s)` };
			}
			if (data.format === 'json') {
				const parsed = JSON.parse(data.content) as Record<string, { type?: string; ttl?: number | null; value: unknown }>;
				let count = 0;
				for (const [key, entry] of Object.entries(parsed)) {
					const type = entry.type ?? 'string';
					let cmd: unknown[] = [];
					switch (type) {
						case 'list': cmd = ['RPUSH', key, ...((entry.value as unknown[]) ?? []).map(String)]; break;
						case 'hash': {
							const obj = (typeof entry.value === 'object' && entry.value !== null) ? entry.value as Record<string, unknown> : {};
							cmd = ['HSET', key, ...Object.entries(obj).flatMap(([k, v]) => [k, String(v)])];
							break;
						}
						case 'set': cmd = ['SADD', key, ...((entry.value as unknown[]) ?? []).map(String)]; break;
						default: cmd = ['SET', key, String(entry.value ?? '')];
					}
					await adapter.executeWrite(JSON.stringify(cmd), [], {});
					if (entry.ttl && entry.ttl > 0) {
						await adapter.executeWrite(JSON.stringify(['EXPIRE', key, String(entry.ttl)]), [], {});
					}
					count++;
				}
				return { ok: true, count, message: `Imported ${count} key(s)` };
			}
			throw new Error(`Format ${data.format} not supported for redis`);
		}

		throw new Error(`Driver ${driver} not supported`);
	});
