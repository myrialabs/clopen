/**
 * Applying a pending migration.
 *
 * The one write path in the Supabase surface, and it goes over SQL rather than
 * through `POST /v1/projects/{ref}/database/migrations`. Two reasons, in order
 * of weight: the SQL path is the only one that also works for a `supabase start`
 * stack, so there is one implementation instead of two; and it is exactly what
 * `supabase db push` does — run the file, then record the version in the CLI's
 * own bookkeeping table — so a migration applied from here is indistinguishable
 * from one applied from the terminal.
 *
 * Everything happens in ONE transaction: Postgres rolls DDL back like anything
 * else, so a migration that fails half way leaves nothing behind, and the
 * version is only recorded if the SQL that earns it succeeded.
 *
 * The known limit is `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside
 * a transaction. The provider's own error says so plainly and is passed through
 * rather than rewritten, because the fix — run that one statement by hand — is
 * something only the user can decide on.
 */

import type { DbClientDriverAdapter, DbClientTxContext } from '../../drivers/types';
import { debug } from '$shared/utils/logger';

const SCHEMA = 'supabase_migrations';
const TABLE = 'schema_migrations';

/**
 * Make sure the CLI's bookkeeping table exists, in the shape the CLI uses.
 *
 * A project that has only ever been changed through the dashboard has no such
 * table, and a project created by an older CLI has the table without its later
 * columns — which is why each column is added separately and idempotently
 * rather than the whole thing being created in one shot and assumed complete.
 */
async function ensureBookkeeping(tx: DbClientTxContext): Promise<void> {
	await tx.executeWrite(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
	await tx.executeWrite(`
		CREATE TABLE IF NOT EXISTS ${SCHEMA}.${TABLE} (
			version text NOT NULL PRIMARY KEY
		)
	`);
	await tx.executeWrite(`ALTER TABLE ${SCHEMA}.${TABLE} ADD COLUMN IF NOT EXISTS statements text[]`);
	await tx.executeWrite(`ALTER TABLE ${SCHEMA}.${TABLE} ADD COLUMN IF NOT EXISTS name text`);
}

export interface ApplyMigrationInput {
	adapter: DbClientDriverAdapter;
	version: string;
	name: string | null;
	sql: string;
}

export interface ApplyMigrationResult {
	version: string;
	/** Milliseconds the whole transaction took, for the report line. */
	durationMs: number;
}

export async function applyMigration(input: ApplyMigrationInput): Promise<ApplyMigrationResult> {
	const { adapter, version, name, sql } = input;

	if (!adapter.withTransaction) {
		throw new Error('This connection cannot run a transaction, so a migration cannot be applied safely from here');
	}
	if (!sql.trim()) {
		throw new Error(`Migration ${version} is empty`);
	}

	const started = performance.now();

	await adapter.withTransaction(async (tx) => {
		await ensureBookkeeping(tx);

		// Guard INSIDE the transaction. Checking before it opens would leave a gap
		// where two people apply the same migration at once and both see it
		// pending; the primary key would then reject the second write after its
		// SQL had already run.
		const existing = await tx.executeRead(
			`SELECT version FROM ${SCHEMA}.${TABLE} WHERE version = '${version.replace(/'/g, "''")}'`
		);
		if (existing.rows.length > 0) {
			throw new Error(`Migration ${version} is already recorded as applied`);
		}

		// The whole file as one statement. Bun's SQL sends a parameterless query
		// over the simple protocol, which is what allows the several statements a
		// migration normally contains; splitting it here would have to understand
		// dollar-quoted function bodies, and getting that wrong truncates a
		// function definition mid-way.
		await tx.executeWrite(sql);

		const escapedVersion = version.replace(/'/g, "''");
		const escapedName = name ? `'${name.replace(/'/g, "''")}'` : 'NULL';
		await tx.executeWrite(`
			INSERT INTO ${SCHEMA}.${TABLE} (version, name)
			VALUES ('${escapedVersion}', ${escapedName})
		`);
	});

	const durationMs = Math.round(performance.now() - started);
	debug.log('db-client', `Applied Supabase migration ${version} in ${durationMs}ms`);
	return { version, durationMs };
}
