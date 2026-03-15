/**
 * Database Diff Engine
 * Compares schemas between two database connections and generates SQL migration scripts.
 */

import type { DBConnectionConfig, DBColumn } from '$shared/types/db-manager';
import type {
	DBIndexInfo,
	DBColumnDiff,
	DBIndexDiff,
	DBTableDiff,
	DBSchemaDiff,
	DBMigrationScript
} from '$shared/types/db-diff';
import { listTables, describeTable } from './index';
import { withSSHTunnel } from './ssh-tunnel';

// ─── Index Introspection ──────────────────────────────────────────────────────

async function getTableIndexes(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<DBIndexInfo[]> {
	return withSSHTunnel(config, async (c) => {
		try {
			switch (c.type) {
				case 'sqlite': {
					const { Database } = await import('bun:sqlite');
					const db = new Database(c.path!);
					try {
						const safe = tableName.replace(/"/g, '""');
						const indexList = db
							.query(`PRAGMA index_list("${safe}")`)
							.all() as { name: string; unique: number; origin: string }[];
						const result: DBIndexInfo[] = [];
						for (const idx of indexList) {
							if (idx.origin === 'pk') continue;
							const idxSafe = idx.name.replace(/"/g, '""');
							const cols = db
								.query(`PRAGMA index_info("${idxSafe}")`)
								.all() as { name: string }[];
							result.push({
								name: idx.name,
								columns: cols.map((col) => col.name),
								unique: idx.unique === 1,
								primary: false
							});
						}
						return result;
					} finally {
						db.close();
					}
				}

				case 'postgresql': {
					const { PostgreSQLAdapter } = await import('./postgres-adapter');
					const adapter = new PostgreSQLAdapter(c);
					const schemaName = schema || 'public';
					const result = await adapter.executeQuery(
						`SELECT indexname, indexdef FROM pg_indexes ` +
							`WHERE tablename = '${tableName.replace(/'/g, "''")}' ` +
							`AND schemaname = '${schemaName.replace(/'/g, "''")}' ` +
							`AND indexname NOT LIKE '%_pkey'`
					);
					if (result.error || !result.rows.length) return [];
					return result.rows.map((r) => {
						const def = (r['indexdef'] as string) ?? '';
						const unique = /\bUNIQUE\b/i.test(def);
						const colMatch = def.match(/\(([^)]+)\)/);
						const columns = colMatch
							? colMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
							: [];
						return { name: r['indexname'] as string, columns, unique, primary: false };
					});
				}

				case 'mysql':
				case 'mariadb': {
					const { MySQLAdapter } = await import('./mysql-adapter');
					const adapter = new MySQLAdapter(c);
					const safe = tableName.replace(/`/g, '``');
					const result = await adapter.executeQuery(
						`SHOW INDEX FROM \`${safe}\` WHERE Key_name != 'PRIMARY'`
					);
					if (result.error || !result.rows.length) return [];
					const grouped = new Map<string, { columns: string[]; unique: boolean }>();
					for (const r of result.rows) {
						const key = r['Key_name'] as string;
						if (!grouped.has(key)) grouped.set(key, { columns: [], unique: r['Non_unique'] === 0 });
						grouped.get(key)!.columns.push(r['Column_name'] as string);
					}
					return Array.from(grouped.entries()).map(([name, info]) => ({
						name,
						columns: info.columns,
						unique: info.unique,
						primary: false
					}));
				}

				case 'mssql': {
					const { MSSQLAdapter } = await import('./mssql-adapter');
					const adapter = new MSSQLAdapter(c);
					const safeName = tableName.replace(/'/g, "''");
					const result = await adapter.executeQuery(
						`SELECT i.name AS idx_name, i.is_unique, c.name AS col_name ` +
							`FROM sys.indexes i ` +
							`JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id ` +
							`JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id ` +
							`JOIN sys.tables t ON i.object_id = t.object_id ` +
							`WHERE t.name = '${safeName}' AND i.is_primary_key = 0 ` +
							`ORDER BY i.name, ic.key_ordinal`
					);
					if (result.error || !result.rows.length) return [];
					const grouped = new Map<string, { columns: string[]; unique: boolean }>();
					for (const r of result.rows) {
						const key = r['idx_name'] as string;
						if (!grouped.has(key)) grouped.set(key, { columns: [], unique: !!r['is_unique'] });
						grouped.get(key)!.columns.push(r['col_name'] as string);
					}
					return Array.from(grouped.entries()).map(([name, info]) => ({
						name,
						columns: info.columns,
						unique: info.unique,
						primary: false
					}));
				}

				default:
					return [];
			}
		} catch {
			return [];
		}
	});
}

// ─── Schema Snapshot ──────────────────────────────────────────────────────────

interface TableSchema {
	tableName: string;
	schema?: string;
	columns: DBColumn[];
	indexes: DBIndexInfo[];
}

async function getFullSchema(config: DBConnectionConfig): Promise<TableSchema[]> {
	const tables = await listTables(config);
	const sqlTables = tables.filter((t) => t.type === 'table');

	return Promise.all(
		sqlTables.map(async (table) => {
			const [columns, indexes] = await Promise.all([
				describeTable(config, table.name, table.schema),
				getTableIndexes(config, table.name, table.schema).catch(() => [] as DBIndexInfo[])
			]);
			return { tableName: table.name, schema: table.schema, columns, indexes };
		})
	);
}

// ─── Diff Comparison ──────────────────────────────────────────────────────────

function compareColumns(sourceColumns: DBColumn[], targetColumns: DBColumn[]): DBColumnDiff[] {
	const result: DBColumnDiff[] = [];
	const targetMap = new Map(targetColumns.map((c) => [c.name.toLowerCase(), c]));
	const sourceMap = new Map(sourceColumns.map((c) => [c.name.toLowerCase(), c]));

	for (const sc of sourceColumns) {
		const tc = targetMap.get(sc.name.toLowerCase());
		if (!tc) {
			result.push({ name: sc.name, status: 'added', source: sc, target: null });
		} else {
			const modified =
				sc.type.toLowerCase() !== tc.type.toLowerCase() ||
				sc.nullable !== tc.nullable ||
				sc.primaryKey !== tc.primaryKey ||
				(sc.defaultValue ?? null) !== (tc.defaultValue ?? null);
			result.push({ name: sc.name, status: modified ? 'modified' : 'unchanged', source: sc, target: tc });
		}
	}

	for (const tc of targetColumns) {
		if (!sourceMap.has(tc.name.toLowerCase())) {
			result.push({ name: tc.name, status: 'removed', source: null, target: tc });
		}
	}

	return result;
}

function compareIndexes(sourceIndexes: DBIndexInfo[], targetIndexes: DBIndexInfo[]): DBIndexDiff[] {
	const result: DBIndexDiff[] = [];
	const targetMap = new Map(targetIndexes.map((i) => [i.name.toLowerCase(), i]));
	const sourceMap = new Map(sourceIndexes.map((i) => [i.name.toLowerCase(), i]));

	for (const si of sourceIndexes) {
		const ti = targetMap.get(si.name.toLowerCase());
		if (!ti) {
			result.push({ name: si.name, status: 'added', source: si, target: null });
		} else {
			const modified =
				si.unique !== ti.unique ||
				JSON.stringify([...si.columns].map((c) => c.toLowerCase()).sort()) !==
					JSON.stringify([...ti.columns].map((c) => c.toLowerCase()).sort());
			result.push({ name: si.name, status: modified ? 'modified' : 'unchanged', source: si, target: ti });
		}
	}

	for (const ti of targetIndexes) {
		if (!sourceMap.has(ti.name.toLowerCase())) {
			result.push({ name: ti.name, status: 'removed', source: null, target: ti });
		}
	}

	return result;
}

export async function compareSchemas(
	sourceConfig: DBConnectionConfig,
	targetConfig: DBConnectionConfig
): Promise<DBSchemaDiff> {
	const [sourceSchema, targetSchema] = await Promise.all([
		getFullSchema(sourceConfig),
		getFullSchema(targetConfig)
	]);

	const sourceMap = new Map(sourceSchema.map((t) => [t.tableName.toLowerCase(), t]));
	const targetMap = new Map(targetSchema.map((t) => [t.tableName.toLowerCase(), t]));

	const tables: DBTableDiff[] = [];
	const summary = {
		tablesAdded: 0,
		tablesRemoved: 0,
		tablesModified: 0,
		columnsAdded: 0,
		columnsRemoved: 0,
		columnsModified: 0,
		indexesAdded: 0,
		indexesRemoved: 0
	};

	for (const st of sourceSchema) {
		const tt = targetMap.get(st.tableName.toLowerCase());
		if (!tt) {
			tables.push({
				tableName: st.tableName,
				schema: st.schema,
				status: 'added',
				columns: st.columns.map((c) => ({ name: c.name, status: 'added', source: c, target: null })),
				indexes: st.indexes.map((i) => ({ name: i.name, status: 'added', source: i, target: null }))
			});
			summary.tablesAdded++;
			summary.columnsAdded += st.columns.length;
			summary.indexesAdded += st.indexes.length;
		} else {
			const columns = compareColumns(st.columns, tt.columns);
			const indexes = compareIndexes(st.indexes, tt.indexes);
			const hasChanges =
				columns.some((c) => c.status !== 'unchanged') ||
				indexes.some((i) => i.status !== 'unchanged');
			tables.push({
				tableName: st.tableName,
				schema: st.schema,
				status: hasChanges ? 'modified' : 'unchanged',
				columns,
				indexes
			});
			if (hasChanges) {
				summary.tablesModified++;
				summary.columnsAdded += columns.filter((c) => c.status === 'added').length;
				summary.columnsRemoved += columns.filter((c) => c.status === 'removed').length;
				summary.columnsModified += columns.filter((c) => c.status === 'modified').length;
				summary.indexesAdded += indexes.filter((i) => i.status === 'added').length;
				summary.indexesRemoved += indexes.filter((i) => i.status === 'removed').length;
			}
		}
	}

	for (const tt of targetSchema) {
		if (!sourceMap.has(tt.tableName.toLowerCase())) {
			tables.push({
				tableName: tt.tableName,
				schema: tt.schema,
				status: 'removed',
				columns: tt.columns.map((c) => ({ name: c.name, status: 'removed', source: null, target: c })),
				indexes: tt.indexes.map((i) => ({ name: i.name, status: 'removed', source: null, target: i }))
			});
			summary.tablesRemoved++;
			summary.columnsRemoved += tt.columns.length;
			summary.indexesRemoved += tt.indexes.length;
		}
	}

	return {
		sourceConnectionId: sourceConfig.id,
		targetConnectionId: targetConfig.id,
		sourceConnectionName: sourceConfig.name,
		targetConnectionName: targetConfig.name,
		tables,
		hasDifferences: tables.some((t) => t.status !== 'unchanged'),
		summary
	};
}

// ─── Migration Script Generator ───────────────────────────────────────────────

function qIdent(name: string, dbType: string): string {
	if (dbType === 'mysql' || dbType === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
	if (dbType === 'mssql') return `[${name.replace(/\]/g, ']]')}]`;
	return `"${name.replace(/"/g, '""')}"`;
}

function tRef(tableName: string, schema: string | undefined, dbType: string): string {
	if (dbType === 'sqlite' || dbType === 'mysql' || dbType === 'mariadb') return qIdent(tableName, dbType);
	if (schema) return `${qIdent(schema, dbType)}.${qIdent(tableName, dbType)}`;
	return qIdent(tableName, dbType);
}

function colDef(col: DBColumn, dbType: string): string {
	const parts: string[] = [qIdent(col.name, dbType), col.type];
	if (!col.nullable) parts.push('NOT NULL');
	if (col.defaultValue != null) parts.push(`DEFAULT ${col.defaultValue}`);
	if (col.primaryKey) parts.push('PRIMARY KEY');
	return parts.join(' ');
}

function idxDrop(idxName: string, ref: string, dbType: string): string {
	if (dbType === 'mysql' || dbType === 'mariadb') return `DROP INDEX ${qIdent(idxName, dbType)} ON ${ref};`;
	return `DROP INDEX IF EXISTS ${qIdent(idxName, dbType)};`;
}

function idxCreate(idx: DBIndexInfo, ref: string, dbType: string, ifNotExists = true): string {
	const unique = idx.unique ? 'UNIQUE ' : '';
	const cols = idx.columns.map((c) => qIdent(c, dbType)).join(', ');
	const idxName = qIdent(idx.name, dbType);
	const guard = ifNotExists && dbType !== 'mysql' && dbType !== 'mariadb' ? 'IF NOT EXISTS ' : '';
	return `CREATE ${unique}INDEX ${guard}${idxName} ON ${ref} (${cols});`;
}

export function generateMigrationScript(diff: DBSchemaDiff, targetType: string): DBMigrationScript {
	const upStmts: string[] = [];
	const downStmts: string[] = [];
	const warnings: string[] = [];

	const isSqlite = targetType === 'sqlite';
	const isMysql = targetType === 'mysql' || targetType === 'mariadb';

	if (diff.sourceConnectionId !== diff.targetConnectionId) {
		const srcType = diff.tables.length > 0 ? '' : '';
		void srcType;
	}

	const added = diff.tables.filter((t) => t.status === 'added');
	const modified = diff.tables.filter((t) => t.status === 'modified');
	const removed = diff.tables.filter((t) => t.status === 'removed');

	// ── Create tables that exist in source but not in target
	for (const table of added) {
		const ref = tRef(table.tableName, table.schema, targetType);
		const sourceCols = table.columns.filter((c) => c.source).map((c) => c.source!);
		const colDefs = sourceCols.map((c) => colDef(c, targetType));
		upStmts.push(`CREATE TABLE IF NOT EXISTS ${ref} (\n  ${colDefs.join(',\n  ')}\n);`);

		for (const idx of table.indexes.filter((i) => i.source)) {
			upStmts.push(idxCreate(idx.source!, ref, targetType));
		}

		downStmts.unshift(`DROP TABLE IF EXISTS ${ref};`);
	}

	// ── Modify tables with differences
	for (const table of modified) {
		const ref = tRef(table.tableName, table.schema, targetType);

		for (const col of table.columns.filter((c) => c.status === 'added' && c.source)) {
			upStmts.push(`ALTER TABLE ${ref} ADD COLUMN ${colDef(col.source!, targetType)};`);
			downStmts.unshift(`ALTER TABLE ${ref} DROP COLUMN ${qIdent(col.name, targetType)};`);
		}

		for (const col of table.columns.filter((c) => c.status === 'removed')) {
			warnings.push(
				`Column "${table.tableName}.${col.name}" exists in target but not in source — skipped (remove manually if intended).`
			);
		}

		for (const col of table.columns.filter((c) => c.status === 'modified' && c.source && c.target)) {
			const sc = col.source!;
			const tc = col.target!;
			if (isSqlite) {
				warnings.push(
					`SQLite: Cannot ALTER column "${table.tableName}.${col.name}" directly — table recreation required.`
				);
			} else if (isMysql) {
				upStmts.push(`ALTER TABLE ${ref} MODIFY COLUMN ${colDef(sc, targetType)};`);
				downStmts.unshift(`ALTER TABLE ${ref} MODIFY COLUMN ${colDef(tc, targetType)};`);
			} else {
				if (sc.type.toLowerCase() !== tc.type.toLowerCase()) {
					upStmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${qIdent(col.name, targetType)} TYPE ${sc.type};`);
					downStmts.unshift(`ALTER TABLE ${ref} ALTER COLUMN ${qIdent(col.name, targetType)} TYPE ${tc.type};`);
				}
				if (sc.nullable !== tc.nullable) {
					const up = sc.nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
					const down = tc.nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
					upStmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${qIdent(col.name, targetType)} ${up};`);
					downStmts.unshift(`ALTER TABLE ${ref} ALTER COLUMN ${qIdent(col.name, targetType)} ${down};`);
				}
			}
		}

		for (const idx of table.indexes.filter((i) => i.status === 'added' && i.source)) {
			upStmts.push(idxCreate(idx.source!, ref, targetType));
			downStmts.unshift(idxDrop(idx.source!.name, ref, targetType));
		}

		for (const idx of table.indexes.filter((i) => i.status === 'removed' && i.target)) {
			upStmts.push(idxDrop(idx.target!.name, ref, targetType));
			downStmts.unshift(idxCreate(idx.target!, ref, targetType));
		}

		for (const idx of table.indexes.filter((i) => i.status === 'modified' && i.source && i.target)) {
			upStmts.push(idxDrop(idx.target!.name, ref, targetType));
			upStmts.push(idxCreate(idx.source!, ref, targetType));
			downStmts.unshift(idxCreate(idx.target!, ref, targetType));
			downStmts.unshift(idxDrop(idx.source!.name, ref, targetType));
		}
	}

	for (const table of removed) {
		warnings.push(
			`Table "${table.tableName}" exists in target but not in source — skipped (add DROP TABLE manually if intended).`
		);
	}

	const header =
		`-- Generated by Clopen Database Diff\n` +
		`-- Source: ${diff.sourceConnectionName}\n` +
		`-- Target: ${diff.targetConnectionName}\n` +
		`-- Generated: ${new Date().toISOString()}\n\n`;

	return {
		up: header + (upStmts.length ? upStmts.join('\n') : '-- No UP changes required'),
		down: header + (downStmts.length ? downStmts.join('\n') : '-- No DOWN changes required'),
		warnings
	};
}

/** Split migration SQL into individual executable statements */
export function splitMigrationStatements(sql: string): string[] {
	return sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => s + ';');
}
