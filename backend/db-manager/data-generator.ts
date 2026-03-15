/**
 * Database Data Generator Service
 * Generates and inserts realistic fake data into database tables,
 * respecting Foreign Key constraints by sampling values from referenced tables.
 */

import { faker } from '@faker-js/faker';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import type {
	DataGenColumnConfig,
	DataGenColumnInfo,
	DataGenBatchResult,
	FakerStrategy
} from '$shared/types/data-generator';
import { describeTableWithFks, executeQuery } from './index';
import { withSSHTunnel } from './ssh-tunnel';
import type { DBColumnDef } from '$shared/types/alter-table';

// ─── SQL helpers ───────────────────────────────────────────────────────────────

function qIdent(name: string, type: string): string {
	if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
	if (type === 'mssql') return `[${name.replace(/\]/g, ']]')}]`;
	return `"${name.replace(/"/g, '""')}"`;
}

function tableRef(tableName: string, schema: string | undefined, type: string): string {
	if (type === 'sqlite' || type === 'mysql' || type === 'mariadb') return qIdent(tableName, type);
	if (schema) return `${qIdent(schema, type)}.${qIdent(tableName, type)}`;
	return qIdent(tableName, type);
}

function formatSqlValue(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	const s = String(v);
	return `'${s.replace(/'/g, "''")}'`;
}

// ─── Auto-increment detection ─────────────────────────────────────────────────

/**
 * Returns true when a column is an auto-managed primary key (AUTOINCREMENT /
 * SERIAL / IDENTITY) that the DB fills on its own — we should skip it.
 */
function isAutoIncrement(col: DBColumnDef): boolean {
	if (!col.primaryKey) return false;
	const t = col.type.toUpperCase();
	// SQLite INTEGER PRIMARY KEY is always rowid alias (auto)
	if (t === 'INTEGER' || t === 'INT') return true;
	// PostgreSQL SERIAL / BIGSERIAL / generated columns
	if (t.includes('SERIAL') || t.includes('GENERATED')) return true;
	// MySQL AUTO_INCREMENT
	if (t.includes('AUTO_INCREMENT')) return true;
	// MSSQL IDENTITY
	if (t.includes('IDENTITY')) return true;
	return false;
}

// ─── Strategy suggestion ──────────────────────────────────────────────────────

/**
 * Heuristically maps a column's name + SQL type to the most appropriate
 * FakerStrategy for seeding realistic data.
 */
export function suggestStrategy(columnName: string, columnType: string): FakerStrategy {
	const name = columnName.toLowerCase().replace(/[\s_-]/g, '');
	const type = columnType.toUpperCase();

	// UUID type or column named uuid
	if (type.startsWith('UUID') || name === 'uuid' || name === 'guid') return 'uuid';

	// Boolean
	if (type.startsWith('BOOL') || type === 'BIT') return 'boolean';

	// Date / time
	if (type === 'DATE') return 'date';
	if (type.startsWith('DATETIME') || type.startsWith('TIMESTAMP') || type === 'TIMESTAMPTZ')
		return 'datetime';

	// Numeric types
	if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|INT8)/.test(type))
		return 'integer';
	if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|MONEY|SMALLMONEY)/.test(type)) return 'float';

	// String / text — match on column name pattern
	if (/^(firstname|fname)$/.test(name)) return 'firstName';
	if (/^(lastname|lname|surname|familyname)$/.test(name)) return 'lastName';
	if (/^(fullname|displayname|name|personname|contactname)$/.test(name)) return 'fullName';
	if (/^(email|emailaddress|mail)$/.test(name)) return 'email';
	if (/^(phone|tel|telephone|mobile|cellphone|cell|phonenumber)$/.test(name)) return 'phone';
	if (/^(address|streetaddress|street|addr)$/.test(name)) return 'address';
	if (/^(city|town|municipality)$/.test(name)) return 'city';
	if (/^(country|nation)$/.test(name)) return 'country';
	if (/^(zip|zipcode|postalcode|postcode|postal)$/.test(name)) return 'zipCode';
	if (/^(company|companyname|organization|organisation|employer|business|firm)$/.test(name))
		return 'company';
	if (/^(url|website|homepage|link|webpage|siteurl)$/.test(name)) return 'url';
	if (/^(username|login|handle|user|account)$/.test(name)) return 'username';

	// Partial matches for common suffixes
	if (name.endsWith('name') && name.includes('first')) return 'firstName';
	if (name.endsWith('name') && name.includes('last')) return 'lastName';
	if (name.endsWith('name')) return 'fullName';
	if (name.endsWith('email')) return 'email';
	if (name.endsWith('phone') || name.endsWith('tel')) return 'phone';
	if (name.endsWith('city')) return 'city';
	if (name.endsWith('country')) return 'country';
	if (name.endsWith('company')) return 'company';
	if (name.endsWith('url') || name.endsWith('link')) return 'url';

	// Default: short text for string columns
	return 'text';
}

// ─── Value generation ──────────────────────────────────────────────────────────

function generateValue(
	strategy: FakerStrategy,
	options: DataGenColumnConfig['options'],
	seqIndex: number
): unknown {
	switch (strategy) {
		case 'firstName':
			return faker.person.firstName();
		case 'lastName':
			return faker.person.lastName();
		case 'fullName':
			return faker.person.fullName();
		case 'email':
			return faker.internet.email();
		case 'phone':
			return faker.phone.number();
		case 'address':
			return faker.location.streetAddress();
		case 'city':
			return faker.location.city();
		case 'country':
			return faker.location.country();
		case 'zipCode':
			return faker.location.zipCode();
		case 'company':
			return faker.company.name();
		case 'url':
			return faker.internet.url();
		case 'username':
			return faker.internet.username();
		case 'uuid':
			return faker.string.uuid();
		case 'integer':
			return faker.number.int({ min: options?.min ?? 1, max: options?.max ?? 1_000_000 });
		case 'float': {
			const decimals = options?.decimals ?? 2;
			return parseFloat(
				faker.number
					.float({ min: options?.min ?? 0, max: options?.max ?? 1000 })
					.toFixed(decimals)
			);
		}
		case 'boolean':
			return faker.datatype.boolean() ? 1 : 0;
		case 'date':
			return faker.date.past({ years: 5 }).toISOString().split('T')[0];
		case 'datetime':
			return faker.date
				.past({ years: 5 })
				.toISOString()
				.replace('T', ' ')
				.replace(/\.\d+Z$/, '');
		case 'text':
			return faker.lorem.words(faker.number.int({ min: 2, max: 5 }));
		case 'words':
			return faker.lorem.words(2);
		case 'sentence':
			return faker.lorem.sentence();
		case 'sequential':
			return seqIndex + 1;
		case 'null':
			return null;
		// fkReference is handled externally via FK pool
		default:
			return faker.lorem.words(2);
	}
}

// ─── FK value pool ────────────────────────────────────────────────────────────

/**
 * Fetches up to 2 000 existing values from the referenced FK table/column,
 * so generated rows always point to valid parent records.
 */
async function fetchFkPool(
	config: DBConnectionConfig,
	fkTable: string,
	fkColumn: string
): Promise<unknown[]> {
	const q = `SELECT DISTINCT ${qIdent(fkColumn, config.type)} FROM ${tableRef(fkTable, undefined, config.type)} LIMIT 2000`;
	try {
		const result = await executeQuery(config, q);
		return result.rows.map((r) => r[fkColumn]).filter((v) => v !== null && v !== undefined);
	} catch {
		return [];
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Inspect a table and return column info enriched with:
 * - Suggested faker strategy based on name + type heuristics
 * - FK references for constrained columns
 * - Auto-increment detection
 */
export async function inspectTableForDatagen(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<DataGenColumnInfo[]> {
	return withSSHTunnel(config, async (resolved) => {
		const cols = (await describeTableWithFks(resolved, tableName, schema)) as DBColumnDef[];
		return cols.map((col): DataGenColumnInfo => {
			const autoInc = isAutoIncrement(col);
			const hasFk = !!col.foreignKey;

			return {
				columnName: col.name,
				columnType: col.type,
				nullable: col.nullable,
				primaryKey: col.primaryKey,
				unique: col.unique,
				defaultValue: col.defaultValue ?? null,
				autoIncrement: autoInc,
				suggestedStrategy: hasFk
					? 'fkReference'
					: autoInc
						? 'sequential'
						: suggestStrategy(col.name, col.type),
				fkTable: col.foreignKey?.table,
				fkColumn: col.foreignKey?.column
			};
		});
	});
}

/**
 * Generate `count` fake rows and insert them into the target table in
 * INSERT batches of `sqlBatchSize` rows, honouring FK constraints.
 *
 * Returns the number of rows successfully inserted and any errors encountered.
 */
export async function generateAndInsert(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	columnConfigs: DataGenColumnConfig[],
	count: number,
	globalOffset: number,
	sqlBatchSize = 100
): Promise<DataGenBatchResult> {
	return withSSHTunnel(config, async (resolved) => {
		// Build FK pools (one per unique fkTable+fkColumn pair)
		const fkPoolMap = new Map<string, unknown[]>();
		for (const col of columnConfigs) {
			if (col.strategy === 'fkReference' && col.fkTable && col.fkColumn) {
				const key = `${col.fkTable}.${col.fkColumn}`;
				if (!fkPoolMap.has(key)) {
					const pool = await fetchFkPool(resolved, col.fkTable, col.fkColumn);
					fkPoolMap.set(key, pool);
				}
			}
		}

		// Active columns (not skipped)
		const activeCols = columnConfigs.filter((c) => !c.skip);
		if (activeCols.length === 0) {
			return { inserted: 0, failed: 0, errors: ['No columns selected for generation'], done: true };
		}

		const colNames = activeCols.map((c) => qIdent(c.columnName, resolved.type)).join(', ');
		const tRef = tableRef(tableName, schema, resolved.type);

		let inserted = 0;
		let failed = 0;
		const errors: string[] = [];

		// Generate all rows, then insert in SQL batches
		const rows: unknown[][] = [];
		for (let i = 0; i < count; i++) {
			const row: unknown[] = activeCols.map((col) => {
				if (col.strategy === 'fkReference' && col.fkTable && col.fkColumn) {
					const key = `${col.fkTable}.${col.fkColumn}`;
					const pool = fkPoolMap.get(key) ?? [];
					if (pool.length === 0) return null;
					return pool[Math.floor(Math.random() * pool.length)];
				}
				return generateValue(col.strategy, col.options, globalOffset + i);
			});
			rows.push(row);
		}

		// Chunk into SQL_BATCH_SIZE VALUE groups
		for (let start = 0; start < rows.length; start += sqlBatchSize) {
			const chunk = rows.slice(start, start + sqlBatchSize);
			const valueClauses = chunk
				.map((row) => `(${row.map(formatSqlValue).join(', ')})`)
				.join(',\n');
			const sql = `INSERT INTO ${tRef} (${colNames}) VALUES\n${valueClauses}`;

			try {
				await executeQuery(resolved, sql);
				inserted += chunk.length;
			} catch (err) {
				failed += chunk.length;
				const msg = err instanceof Error ? err.message : String(err);
				if (errors.length < 5) errors.push(msg);
			}
		}

		return { inserted, failed, errors, done: true };
	});
}
