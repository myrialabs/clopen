import type { DatabaseConnection } from '$shared/types/database/connection';
import { isSealed, open, seal, SECRET_COLUMNS } from '../crypto';
import { debug } from '$shared/utils/logger';

export const description = 'Re-encrypt every stored secret with the AES-256-GCM envelope';

/**
 * Seal the secrets that were written before the crypto layer existed.
 *
 * THIS MUST USE RAW SQL. The query modules now seal on write and open on read,
 * so routing this through them would encrypt an already-encrypted value on the
 * way in and hand back plaintext on the way out — the migration would appear to
 * do nothing while corrupting every row it touched.
 *
 * Two properties of the envelope make the pass safe to interrupt and safe to
 * repeat: an unprefixed value is pre-migration plaintext and gets sealed, and a
 * value that already carries the prefix is left exactly as it is. A half-applied
 * migration therefore reads correctly, and a re-run cannot double-encrypt.
 *
 * `integration_accounts` is deliberately absent: migration 073 creates it, and
 * everything written to it is sealed from the first insert.
 */
const TABLES: Record<string, readonly string[]> = {
	mcp_servers: SECRET_COLUMNS.mcp_servers!,
	db_client_connections: SECRET_COLUMNS.db_client_connections!,
	ssh_connections: SECRET_COLUMNS.ssh_connections!,
	engine_accounts: SECRET_COLUMNS.engine_accounts!
};

function existingTables(db: DatabaseConnection): Set<string> {
	const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
	return new Set(rows.map((row) => row.name));
}

/**
 * Walk one column and rewrite each value through `transform`.
 *
 * Targeted by `rowid` rather than a primary key: the four tables use three
 * different key names and types, and `rowid` is identical on all of them.
 */
function rewriteColumn(
	db: DatabaseConnection,
	table: string,
	column: string,
	transform: (value: string) => string | null
): number {
	const rows = db.prepare(
		`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`
	).all() as { rid: number; value: unknown }[];

	const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
	let changed = 0;

	for (const row of rows) {
		if (typeof row.value !== 'string') continue;
		const next = transform(row.value);
		if (next === null || next === row.value) continue;
		update.run(next, row.rid);
		changed += 1;
	}

	return changed;
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Sealing stored secrets...');

	const present = existingTables(db);
	let total = 0;

	for (const [table, columns] of Object.entries(TABLES)) {
		if (!present.has(table)) continue;
		for (const column of columns) {
			total += rewriteColumn(db, table, column, (value) => (isSealed(value) ? null : seal(value)));
		}
	}

	debug.log('migration', `Sealed ${total} secret value(s)`);
};

/**
 * Unseal everything back to plaintext.
 *
 * A rollback that left ciphertext behind would be data loss the moment the key
 * file went away, so `down()` has to be a real decryption pass rather than a
 * no-op. A value the active key cannot open is left untouched: overwriting it
 * with null would destroy the only copy, and leaving the envelope in place at
 * least keeps it recoverable once the right key comes back.
 */
export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Unsealing stored secrets...');

	const present = existingTables(db);
	let total = 0;

	for (const [table, columns] of Object.entries(TABLES)) {
		if (!present.has(table)) continue;
		for (const column of columns) {
			total += rewriteColumn(db, table, column, (value) => {
				if (!isSealed(value)) return null;
				return open(value);
			});
		}
	}

	debug.log('migration', `Unsealed ${total} secret value(s)`);
};
