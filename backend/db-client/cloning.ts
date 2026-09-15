/**
 * Copying a database, using whatever the server itself can do.
 *
 * This is what makes "give this worktree its own database" a property of every
 * database Clopen can reach, rather than of the one provider that happens to
 * sell branching. Neon cuts a copy-on-write branch through its API; everything
 * else gets a sibling database on the same server, made with that engine's own
 * primitives.
 *
 * NO EXTERNAL CLI. Not `pg_dump`, not `mysqldump`, not `mongodump`. Clopen ships
 * to Linux, macOS and Windows and installs no database tooling, so a strategy
 * that shells out is one that works on the maintainer's machine and nowhere
 * else. Everything below is SQL or a driver command.
 *
 * FIDELITY IS REPORTED, NEVER ASSUMED. The strategies differ in what they carry:
 * Postgres's `TEMPLATE` copies a database whole, while a table-by-table copy
 * carries structure and rows and leaves foreign keys, triggers, views and
 * routines behind. That difference decides whether a migration an agent runs in
 * a worktree will also work on main, so every result says which strategy ran
 * and what it did not bring.
 *
 * TRANSIENT CONNECTIONS, not the pooled one, wherever the work is per-database.
 * Two reasons, both of which bit first: Postgres refuses `CREATE DATABASE …
 * TEMPLATE` while ANY session is connected to the template — including Clopen's
 * own pool — and the Redis adapter holds a single client whose logical database
 * comes from its URL, so a `SELECT 3` issued on it would silently move every
 * other query in the panel.
 *
 * Reused rather than owned: this is a DB Client capability — "copy a database" —
 * and worktree branching is its first caller.
 */

import type {
	DbClientConnection,
	DbClientConnectionInput,
	DbClientQueryResult,
	DbDriver
} from '$shared/types/db-client';
import { connectionManager } from './connection-manager';
import type { DbClientDriverAdapter } from './drivers/types';
import { assertSafeIdentifier, quoteMssql, quoteMysql, quotePg } from './drivers/sql-builders';
import { debug } from '$shared/utils/logger';

/** How much of the parent comes across. */
export type DbCloneMode = 'schema-data' | 'schema' | 'empty';

/** Which mechanism actually ran, for the sentence shown afterwards. */
export type DbCloneStrategy =
	| 'template'
	| 'server-copy'
	| 'row-copy'
	| 'file-copy'
	| 'logical-db'
	| 'empty';

export interface DbCloneResult {
	/** The new database's name, its file path for SQLite, its index for Redis. */
	database: string;
	strategy: DbCloneStrategy;
	/** One sentence naming what did not come across, or null when nothing did not. */
	notice: string | null;
}

/** What copying can do for a driver, before anything is attempted. */
export interface DbCloneSupport {
	canClone: boolean;
	/** One sentence naming the limit, shown BEFORE the user commits to it. */
	notice: string | null;
}

/** Rows moved per round trip when a copy has to go through Clopen. */
const ROW_BATCH = 500;

/** What a table-by-table copy cannot carry, said once. */
const PARTIAL_COPY_NOTICE =
	'Copied table by table, so foreign keys, triggers, views and routines do not come across.';

/**
 * SQL Server's is worse, and says so.
 *
 * `SELECT … INTO` builds the destination table from the shape of the result
 * set, which is columns and nothing else — so indexes, keys and defaults are
 * missing on top of everything `PARTIAL_COPY_NOTICE` already lists.
 */
const MSSQL_COPY_NOTICE =
	'Copied table by table, so indexes, keys, defaults and routines do not come across.';

export function cloneSupport(driver: DbDriver): DbCloneSupport {
	switch (driver) {
		case 'postgres':
			// The faithful path needs exclusive access to the parent and the
			// fallback is always available, so the capability never disappears and
			// there is nothing to warn about up front.
			return { canClone: true, notice: null };
		case 'mysql':
			return { canClone: true, notice: PARTIAL_COPY_NOTICE };
		case 'mssql':
			return { canClone: true, notice: MSSQL_COPY_NOTICE };
		case 'sqlite':
			return { canClone: true, notice: null };
		case 'mongodb':
			return {
				canClone: true,
				notice: 'Collections and their indexes are copied; validators and views are not.'
			};
		case 'redis':
			return {
				canClone: true,
				notice:
					'A Redis copy is another logical database on the same server, so the two share memory and eviction.'
			};
	}
}

/** Whether this connection could be a branch parent at all. */
export function canBranchFrom(connection: DbClientConnection): boolean {
	if (!cloneSupport(connection.driver).canClone) return false;
	// An SSH tunnel belongs to Clopen's own process, so a copy made through one
	// is reachable from Clopen and from nowhere the project runs.
	return !connection.ssh?.enabled;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A connection of our own, pointed wherever this step needs to be.
 *
 * Always closed, including on failure: a leaked adapter holds a session, and a
 * held session is the exact thing that makes the next `CREATE DATABASE …
 * TEMPLATE` fall back to the slow path.
 */
async function withTransient<T>(
	connection: DbClientConnection,
	database: string | null,
	run: (adapter: DbClientDriverAdapter) => Promise<T>
): Promise<T> {
	const input: DbClientConnectionInput = {
		name: connection.name,
		driver: connection.driver,
		host: connection.host ?? undefined,
		port: connection.port ?? undefined,
		username: connection.username ?? undefined,
		password: connection.password ?? undefined,
		database: database ?? connection.database ?? undefined,
		sslMode: connection.sslMode,
		sslCa: connection.sslCa ?? undefined,
		options: connection.options
	};

	const { adapter, tunnel } = await connectionManager.openTransient(input);
	try {
		return await run(adapter);
	} finally {
		await adapter.close().catch((error) => {
			debug.warn('db-client', `Transient adapter close failed: ${messageOf(error)}`);
		});
		await tunnel?.close().catch((error) => {
			debug.warn('db-client', `Transient tunnel close failed: ${messageOf(error)}`);
		});
	}
}

async function read(
	adapter: DbClientDriverAdapter,
	sql: string,
	database?: string
): Promise<DbClientQueryResult> {
	if (!adapter.executeRead) throw new Error('This connection cannot run queries.');
	return adapter.executeRead(sql, [], { database, limit: 1_000_000 });
}

async function write(
	adapter: DbClientDriverAdapter,
	sql: string,
	database?: string
): Promise<void> {
	if (!adapter.executeWrite) throw new Error('This connection cannot run statements.');
	await adapter.executeWrite(sql, [], { database });
}

/** Every database on the server, as plain names. */
export async function listDatabaseNames(connectionId: string): Promise<string[]> {
	const adapter = await connectionManager.get(connectionId);
	if (!adapter.listDatabases) return [];
	return (await adapter.listDatabases()).map((node) => node.name);
}

/**
 * Copy one database into a new one beside it.
 *
 * The caller passes the saved connection rather than its id because most of
 * this work happens on connections of our own — see the module note.
 */
export async function cloneDatabase(input: {
	connection: DbClientConnection;
	/** The database to copy. A file path for SQLite, an index for Redis. */
	source: string;
	/** The name to create. A file path for SQLite, an index for Redis. */
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	// Let go of the pooled session first. For Postgres it is what decides which
	// strategy is even available; for SQLite it is what makes the file safe to
	// copy; everywhere else it costs one reconnect.
	await connectionManager.release(input.connection.id);

	switch (input.connection.driver) {
		case 'postgres':
			return clonePostgres(input);
		case 'mysql':
			return cloneMysql(input);
		case 'mssql':
			return cloneMssql(input);
		case 'mongodb':
			return cloneMongo(input);
		case 'redis':
			return cloneRedis(input);
		case 'sqlite':
			return cloneSqlite(input);
	}
}

/**
 * Drop a copy.
 *
 * Never the parent: every path here is given the copy's own name, and the
 * callers get that name from the row that recorded the copy rather than from
 * anything a user typed.
 */
export async function dropClonedDatabase(input: {
	connection: DbClientConnection;
	database: string;
}): Promise<void> {
	await connectionManager.release(input.connection.id);
	const driver = input.connection.driver;

	if (driver === 'sqlite') {
		const fs = await import('fs/promises');
		// The journal files are part of the database, not debris beside it.
		for (const suffix of ['', '-wal', '-shm']) {
			await fs.rm(`${input.database}${suffix}`, { force: true });
		}
		return;
	}

	if (driver === 'redis') {
		await withTransient(input.connection, input.database, async (adapter) => {
			await write(adapter, 'FLUSHDB');
		});
		return;
	}

	if (driver === 'mongodb') {
		// The command layer addresses COLLECTIONS, so there is no `dropDatabase`
		// to call — and a Mongo database with no collections is a Mongo database
		// that no longer exists in any way a user can see.
		await withTransient(input.connection, input.database, async (adapter) => {
			for (const name of await collectionNames(adapter, input.database)) {
				await write(adapter, mongoCommand(name, 'drop'), input.database);
			}
		});
		return;
	}

	assertSafeIdentifier(input.database);
	const maintenance = driver === 'postgres' ? 'postgres' : null;
	await withTransient(input.connection, maintenance, async (adapter) => {
		if (!adapter.dropDatabase) throw new Error('This connection cannot drop databases.');
		await adapter.dropDatabase(input.database);
	});
}

/* ---------------------------------------------------------------- postgres */

/**
 * `CREATE DATABASE … TEMPLATE` first, table-by-table second.
 *
 * The template path is the only one that carries a database whole — constraints,
 * triggers, sequences, extensions, the lot. Postgres refuses it while any other
 * session is connected to the template, which on a machine running the
 * project's own dev server is most of the time. So the refusal is not an error
 * here: it is the signal to take the slower path, which is always available and
 * costs nothing but time and the fidelity the result then reports.
 *
 * Terminating the blocking sessions would give the faithful copy back, and it
 * is deliberately not done: those sessions are someone's running application.
 */
async function clonePostgres(input: {
	connection: DbClientConnection;
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	assertSafeIdentifier(input.target);

	return withTransient(input.connection, 'postgres', async (adapter) => {
		if (input.mode === 'schema-data') {
			try {
				await write(
					adapter,
					`CREATE DATABASE ${quotePg(input.target)} TEMPLATE ${quotePg(input.source)}`,
					'postgres'
				);
				return { database: input.target, strategy: 'template' as const, notice: null };
			} catch (error) {
				debug.log(
					'db-client',
					`Postgres TEMPLATE copy refused (${messageOf(error)}), copying table by table instead`
				);
			}
		}

		await write(adapter, `CREATE DATABASE ${quotePg(input.target)}`, 'postgres');
		if (input.mode === 'empty') {
			return { database: input.target, strategy: 'empty' as const, notice: null };
		}

		await copyTablesThroughClopen(adapter, {
			source: input.source,
			target: input.target,
			withData: input.mode === 'schema-data',
			quote: quotePg
		});
		return {
			database: input.target,
			strategy: 'row-copy' as const,
			notice: PARTIAL_COPY_NOTICE
		};
	});
}

/* ------------------------------------------------------------------- mysql */

/**
 * Server-side, and the data never crosses the wire.
 *
 * MySQL addresses tables as `database.table` within one connection, so both
 * halves of the copy are statements the server runs against its own storage.
 * `CREATE TABLE … LIKE` carries columns and indexes; foreign keys, triggers,
 * views and routines it does not, which is what the notice says.
 */
async function cloneMysql(input: {
	connection: DbClientConnection;
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	assertSafeIdentifier(input.target);

	return withTransient(input.connection, input.source, async (adapter) => {
		await write(adapter, `CREATE DATABASE ${quoteMysql(input.target)}`);
		if (input.mode === 'empty') {
			return { database: input.target, strategy: 'empty' as const, notice: null };
		}

		for (const table of await tableNames(adapter, input.source)) {
			const from = `${quoteMysql(input.source)}.${quoteMysql(table)}`;
			const to = `${quoteMysql(input.target)}.${quoteMysql(table)}`;
			await write(adapter, `CREATE TABLE ${to} LIKE ${from}`);
			if (input.mode === 'schema-data') {
				await write(adapter, `INSERT INTO ${to} SELECT * FROM ${from}`);
			}
		}

		return {
			database: input.target,
			strategy: 'server-copy' as const,
			notice: PARTIAL_COPY_NOTICE
		};
	});
}

/* ------------------------------------------------------------------- mssql */

/**
 * `SELECT … INTO`, which creates the table and fills it in one statement.
 *
 * Cross-database within an instance is native here, so this is server-side like
 * MySQL's. What `SELECT INTO` does NOT create is indexes, keys or defaults —
 * more missing than MySQL's `LIKE`, so this one has its own sentence.
 */
async function cloneMssql(input: {
	connection: DbClientConnection;
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	assertSafeIdentifier(input.target);

	return withTransient(input.connection, input.source, async (adapter) => {
		await write(adapter, `CREATE DATABASE ${quoteMssql(input.target)}`);
		if (input.mode === 'empty') {
			return { database: input.target, strategy: 'empty' as const, notice: null };
		}

		for (const table of await tableNames(adapter, input.source)) {
			const from = `${quoteMssql(input.source)}.dbo.${quoteMssql(table)}`;
			const to = `${quoteMssql(input.target)}.dbo.${quoteMssql(table)}`;
			// `TOP 0` builds the table and copies no rows, which is the schema-only
			// case expressed in the same statement rather than a second code path.
			const top = input.mode === 'schema' ? 'TOP 0 ' : '';
			await write(adapter, `SELECT ${top}* INTO ${to} FROM ${from}`);
		}

		return {
			database: input.target,
			strategy: 'server-copy' as const,
			notice: MSSQL_COPY_NOTICE
		};
	});
}

/* ----------------------------------------------------------------- mongodb */

/** The command shape this driver parses: a collection, an op, and its args. */
function mongoCommand(collection: string, op: string, args: unknown[] = []): string {
	return JSON.stringify({ collection, op, args });
}

/**
 * `$out` into the new database, which the server performs itself.
 *
 * Indexes are re-created afterwards, because `$out` writes a collection and
 * nothing else — and an index-less copy of a large collection is a worktree
 * where every query is a scan.
 */
async function cloneMongo(input: {
	connection: DbClientConnection;
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	if (input.mode === 'empty') {
		// Mongo creates a database on its first write, so there is nothing to do
		// here and nothing to pretend about.
		return { database: input.target, strategy: 'empty', notice: null };
	}

	return withTransient(input.connection, input.source, async (adapter) => {
		for (const name of await collectionNames(adapter, input.source)) {
			// `$limit: 0` is the schema-only case: the pipeline still runs and
			// `$out` still creates the collection, with nothing in it.
			const pipeline = input.mode === 'schema' ? [{ $limit: 0 }] : [];
			await write(
				adapter,
				mongoCommand(name, 'aggregate', [
					[...pipeline, { $out: { db: input.target, coll: name } }]
				]),
				input.source
			);

			try {
				const found = await read(adapter, mongoCommand(name, 'indexes'), input.source);
				const specs = found.rows
					.filter((row) => row.name !== '_id_')
					.map((row) => ({ key: row.key, name: row.name, unique: row.unique === true }));
				if (specs.length > 0) {
					await write(adapter, mongoCommand(name, 'createIndexes', [specs]), input.target);
				}
			} catch (error) {
				// An index that could not be re-created costs performance, not
				// correctness, so it is logged rather than failing the whole copy.
				debug.warn('db-client', `Could not copy indexes for ${name}: ${messageOf(error)}`);
			}
		}

		return {
			database: input.target,
			strategy: 'server-copy' as const,
			notice: cloneSupport('mongodb').notice
		};
	});
}

/* ------------------------------------------------------------------- redis */

/**
 * Another logical database on the same server.
 *
 * Redis has no second database to create — it has numbered ones, and a copy is
 * keys moved into a free index with `COPY … DB n`. Which index is free is a
 * question about the server, so the caller picks it and passes it as `target`.
 *
 * Both halves run on CONNECTIONS OF OUR OWN, one per index. The panel's adapter
 * holds a single client whose index came from its URL, and a `SELECT` on it
 * would move every other query in DB Client without anything saying so.
 */
async function cloneRedis(input: {
	connection: DbClientConnection;
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	const index = Number(input.target);
	if (!Number.isInteger(index) || index < 0) {
		throw new Error(`"${input.target}" is not a Redis database index.`);
	}

	await withTransient(input.connection, input.target, async (adapter) => {
		await write(adapter, 'FLUSHDB');
	});

	// Redis has no schema, so "schema only" and "empty" describe the same
	// database and pretending otherwise would be inventing a distinction.
	if (input.mode !== 'schema-data') {
		return { database: input.target, strategy: 'empty', notice: null };
	}

	const copied = await withTransient(input.connection, input.source, async (adapter) => {
		let cursor = '0';
		let count = 0;
		do {
			const scan = await read(adapter, `SCAN ${cursor} COUNT 500`);
			const row = (scan.rows[0] ?? {}) as Record<string, unknown>;
			cursor = String(row.cursor ?? '0');
			const keys = Array.isArray(row.keys) ? (row.keys as string[]) : [];
			for (const key of keys) {
				await write(adapter, `COPY ${JSON.stringify(key)} ${JSON.stringify(key)} DB ${index} REPLACE`);
				count += 1;
			}
		} while (cursor !== '0');
		return count;
	});

	debug.log('db-client', `Copied ${copied} Redis key(s) into database ${index}`);
	return { database: input.target, strategy: 'logical-db', notice: cloneSupport('redis').notice };
}

/* ------------------------------------------------------------------ sqlite */

/**
 * Copy the file, which IS the whole database.
 *
 * The most literal strategy here and the most faithful: everything the other
 * paths have to apologise for comes across, because none of it is being
 * re-created. The `-wal` and `-shm` files come too — a copy without them can be
 * missing committed transactions.
 */
async function cloneSqlite(input: {
	source: string;
	target: string;
	mode: DbCloneMode;
}): Promise<DbCloneResult> {
	const fs = await import('fs/promises');

	if (input.mode === 'empty') {
		await fs.writeFile(input.target, '');
		return { database: input.target, strategy: 'empty', notice: null };
	}

	await fs.copyFile(input.source, input.target);
	for (const suffix of ['-wal', '-shm']) {
		try {
			await fs.copyFile(`${input.source}${suffix}`, `${input.target}${suffix}`);
		} catch {
			// Absent in the ordinary case: a database not in WAL mode has neither.
		}
	}

	if (input.mode === 'schema') {
		// Emptying the COPY is safe in a way emptying the original never would be,
		// and it is the only route from a file copy to schema-without-data.
		const { Database } = await import('bun:sqlite');
		const db = new Database(input.target);
		try {
			const tables = db
				.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
				.all() as { name: string }[];
			for (const table of tables) db.run(`DELETE FROM "${table.name.replace(/"/g, '""')}"`);
		} finally {
			db.close();
		}
	}

	return { database: input.target, strategy: 'file-copy', notice: null };
}

/* ------------------------------------------------------------------ shared */

async function tableNames(adapter: DbClientDriverAdapter, database: string): Promise<string[]> {
	if (!adapter.listObjects) throw new Error('This connection cannot list tables.');
	const nodes = await adapter.listObjects(database);
	return nodes.filter((node) => node.type === 'table').map((node) => node.name);
}

async function collectionNames(
	adapter: DbClientDriverAdapter,
	database: string
): Promise<string[]> {
	if (!adapter.listObjects) throw new Error('This connection cannot list collections.');
	const nodes = await adapter.listObjects(database);
	return nodes.filter((node) => node.type === 'collection').map((node) => node.name);
}

/**
 * Structure and rows, one table at a time, through Clopen.
 *
 * The fallback of last resort for Postgres, where cross-database SQL does not
 * exist: every row is read into this process and written back out. Slow and
 * memory-hungry next to anything the server does itself, which is why it is a
 * fallback — but it needs no permission the user does not already have and no
 * tool they have not already installed.
 */
async function copyTablesThroughClopen(
	adapter: DbClientDriverAdapter,
	input: {
		source: string;
		target: string;
		withData: boolean;
		quote: (name: string) => string;
	}
): Promise<void> {
	const quote = input.quote;

	for (const table of await tableNames(adapter, input.source)) {
		if (!adapter.getObjectDetails) throw new Error('This connection cannot describe tables.');

		const details = await adapter.getObjectDetails(table, 'table', input.source);
		const columns = details.columns ?? [];
		if (columns.length === 0) continue;

		const lines = columns.map((column) => {
			const parts = [quote(column.name), column.type];
			if (!column.nullable) parts.push('NOT NULL');
			if (column.default !== null && column.default !== undefined && column.default !== '') {
				parts.push(`DEFAULT ${column.default}`);
			}
			if (column.isPrimary) parts.push('PRIMARY KEY');
			else if (column.isUnique) parts.push('UNIQUE');
			return `  ${parts.join(' ')}`;
		});
		await write(adapter, `CREATE TABLE ${quote(table)} (\n${lines.join(',\n')}\n)`, input.target);

		if (!input.withData) continue;

		const rows = await read(adapter, `SELECT * FROM ${quote(table)}`, input.source);
		const names = rows.columns.map((column) => column.name);
		const columnSql = names.map(quote).join(', ');

		for (let offset = 0; offset < rows.rows.length; offset += ROW_BATCH) {
			const values = rows.rows
				.slice(offset, offset + ROW_BATCH)
				.map((row) => `(${names.map((name) => literal(row[name])).join(', ')})`)
				.join(', ');
			await write(
				adapter,
				`INSERT INTO ${quote(table)} (${columnSql}) VALUES ${values}`,
				input.target
			);
		}
	}
}

/**
 * A value as SQL text.
 *
 * Literals rather than parameters because the statement is assembled in batches
 * of five hundred rows, and a placeholder list that long is slower than the
 * string it would replace. Every branch escapes; the identifiers around it are
 * quoted by the driver's own quoter, which rejects what it cannot escape.
 */
function literal(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (value instanceof Date) return `'${value.toISOString()}'`;
	if (value instanceof Uint8Array) return `'\\x${Buffer.from(value).toString('hex')}'`;
	if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
	return `'${String(value).replace(/'/g, "''")}'`;
}
