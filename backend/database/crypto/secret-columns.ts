/**
 * The single declaration of which columns hold secrets.
 *
 * Sealing happens in the QUERY MODULES (`backend/database/queries/`) rather than
 * inside a wrapper around the connection. That choice is deliberate: an
 * automatic wrapper would have to parse SQL to map `?` placeholders onto
 * columns, and a mis-parse fails silently in the worst possible direction —
 * storing plaintext while reporting success. Every statement touching these
 * columns already lives in a query module, so there is nothing for the parse to
 * buy.
 *
 * What the wrapper WOULD have given us for free is a safety net, so this module
 * provides it explicitly: `auditSecretColumns()` reads every declared column and
 * reports any value sitting there unsealed. It runs at startup outside
 * production and is what catches a future query module that forgets to seal.
 */

import type { DatabaseConnection } from '$shared/types/database/connection';
import { isSealed, open, seal } from './envelope';
import { debug } from '$shared/utils/logger';

/** Every table that stores a secret, and which of its columns do. */
export const SECRET_COLUMNS: Record<string, readonly string[]> = {
	// JSON blobs: the whole column is sealed, not individual keys inside it.
	// Engines read these through `resolveServerRow()`, which is unchanged.
	mcp_servers: ['env', 'headers', 'oauth'],
	db_client_connections: ['password', 'ssh_password', 'ssh_private_key', 'ssh_passphrase'],
	ssh_connections: ['password', 'private_key', 'passphrase'],
	engine_accounts: ['credential'],
	integration_accounts: ['credentials']
} as const;

/** Column names of one table, or an empty list when the table holds no secrets. */
export function secretColumnsOf(table: string): readonly string[] {
	return SECRET_COLUMNS[table] ?? [];
}

/**
 * Open every declared secret column on a row read straight out of SQLite.
 *
 * Mutates a shallow copy, so the caller's row object is untouched. A column the
 * active key cannot open becomes `null` — the caller then behaves exactly as it
 * would for a credential that was never set, which is the only safe degradation.
 */
export function openRow<T extends object>(table: string, row: T): T {
	const columns = secretColumnsOf(table);
	if (columns.length === 0) return row;

	// Rows are declared as interfaces without an index signature, so the write
	// goes through a widened alias rather than `keyof T` — the column names come
	// from the registry, not from the type.
	const out = { ...row } as Record<string, unknown>;
	for (const column of columns) {
		const value = out[column];
		if (typeof value === 'string') {
			out[column] = open(value);
		}
	}
	return out as T;
}

/** `openRow` over a result set. */
export function openRows<T extends object>(table: string, rows: T[]): T[] {
	const columns = secretColumnsOf(table);
	if (columns.length === 0) return rows;
	return rows.map((row) => openRow(table, row));
}

/**
 * Seal one value for a declared column.
 *
 * Named rather than positional because the write paths in the query modules
 * build their parameter lists by hand — `sealFor('ssh_connections', 'password',
 * value)` at the call site reads as what it is, and a column that is not
 * declared secret throws instead of silently passing plaintext through.
 */
export function sealFor(table: string, column: string, value: string | null | undefined): string | null {
	if (!secretColumnsOf(table).includes(column)) {
		throw new Error(`${table}.${column} is not declared in SECRET_COLUMNS`);
	}
	return seal(value);
}

export interface SecretColumnAudit {
	table: string;
	column: string;
	/** Rows holding a non-empty value that is NOT sealed. */
	unsealed: number;
	/** Rows holding a sealed value. */
	sealed: number;
}

/**
 * Report any declared secret column still holding plaintext.
 *
 * A non-zero `unsealed` count after migration 072 means one of two things: a
 * write path that skips `sealFor`, or a table written before the migration ran.
 * Both are worth knowing about, and neither is visible any other way.
 */
export function auditSecretColumns(db: DatabaseConnection): SecretColumnAudit[] {
	const existing = new Set(
		(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
			.map((r) => r.name)
	);

	const results: SecretColumnAudit[] = [];

	for (const [table, columns] of Object.entries(SECRET_COLUMNS)) {
		if (!existing.has(table)) continue;

		for (const column of columns) {
			try {
				const rows = db.prepare(
					`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`
				).all() as { value: unknown }[];

				let unsealed = 0;
				let sealed = 0;
				for (const { value } of rows) {
					if (typeof value !== 'string') continue;
					if (isSealed(value)) sealed += 1;
					else unsealed += 1;
				}
				results.push({ table, column, unsealed, sealed });
			} catch (error) {
				// A declared column the schema does not have yet (a migration is
				// mid-flight, or the declaration ran ahead of the table). Not fatal.
				debug.warn('database', `Secret-column audit skipped ${table}.${column}:`, error);
			}
		}
	}

	return results;
}

/** Log the audit when anything is still plaintext. Called at startup outside production. */
export function logSecretColumnAudit(db: DatabaseConnection): void {
	const leaks = auditSecretColumns(db).filter((entry) => entry.unsealed > 0);
	if (leaks.length === 0) return;

	for (const leak of leaks) {
		debug.warn(
			'database',
			`🔓 ${leak.table}.${leak.column} holds ${leak.unsealed} unsealed value(s) — a write path is missing sealFor()`
		);
	}
}
