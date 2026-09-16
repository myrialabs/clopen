import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create integration_db_links and widen integration_projections to many rows per capability';

/**
 * One account, many derived rows.
 *
 * `integration_projections` was keyed `(account_id, capability, target_kind)`,
 * which encoded an assumption that only held for the first capability shipped:
 * an account with agent tools owns exactly one `mcp_servers` row. A database
 * account does not work that way. One Supabase personal access token reaches
 * every project in every organisation the user belongs to, so "which database"
 * is not a property of the credential — it is a choice the user makes, possibly
 * several times.
 *
 * The alternative was one account per remote database, and it is the same
 * mistake `Task 3` refused for Vercel teams: it would make a user with a
 * production and a staging project paste the same token twice and rotate it in
 * two places. So the key gains `target_id`, and the choices themselves get a
 * table.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Widening integration_projections primary key...');

	// SQLite cannot alter a primary key, so the table is rebuilt. It is small
	// (one row per projected surface row) and the copy is a straight SELECT —
	// every column keeps its meaning, only the key widens.
	db.exec('PRAGMA foreign_keys = OFF;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_projections_new (
			account_id   TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			capability   TEXT NOT NULL,
			target_kind  TEXT NOT NULL,
			target_id    TEXT NOT NULL,
			adopted      INTEGER NOT NULL DEFAULT 0,
			restore_json TEXT,
			created_at   TEXT NOT NULL,
			PRIMARY KEY (account_id, capability, target_kind, target_id)
		)
	`);

	db.exec(`
		INSERT INTO integration_projections_new (
			account_id, capability, target_kind, target_id, adopted, restore_json, created_at
		)
		SELECT account_id, capability, target_kind, target_id, adopted, restore_json, created_at
		FROM integration_projections;
	`);

	db.exec('DROP TABLE integration_projections;');
	db.exec('ALTER TABLE integration_projections_new RENAME TO integration_projections;');

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_projections_target
		ON integration_projections(target_kind, target_id)
	`);

	db.exec('PRAGMA foreign_keys = ON;');

	debug.log('migration', 'Creating integration_db_links table...');

	// One row per remote database the user chose to bring into DB Client.
	//
	// `secrets` is a sealed JSON blob rather than a password column because the
	// secret a database provider needs is not the same everywhere: Supabase
	// needs the Postgres password (which its Management API deliberately cannot
	// read back), Turso needs an auth token, and a later provider may need a
	// client certificate. It lives HERE rather than only on the projected
	// connection because a projection must be rebuildable from the account plus
	// the link alone — a release followed by a re-project must not silently drop
	// the password and leave a connection that can no longer log in.
	//
	// `remote_ref` is the provider's own identifier for the database (a Supabase
	// project ref, a Neon project id). `(account_id, remote_ref)` is unique: two
	// links to the same remote database from one account would project two
	// connections to the same place.
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_db_links (
			id          TEXT PRIMARY KEY,
			account_id  TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			remote_ref  TEXT NOT NULL,
			label       TEXT NOT NULL,
			driver      TEXT NOT NULL,
			mode        TEXT NOT NULL DEFAULT 'pooler-session',
			secrets     TEXT NOT NULL DEFAULT '{}',
			config_json TEXT NOT NULL DEFAULT '{}',
			detected    INTEGER NOT NULL DEFAULT 0,
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL,
			UNIQUE (account_id, remote_ref)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_db_links_account
		ON integration_db_links(account_id)
	`);

	debug.log('migration', 'integration_db_links created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping integration_db_links...');
	db.exec('DROP INDEX IF EXISTS idx_integration_db_links_account');
	db.exec('DROP TABLE IF EXISTS integration_db_links');

	// Narrow the key back. A row that only exists because the wider key allowed
	// it would collide, so the copy keeps the first row per narrow key — the
	// projections it drops are exactly the ones the old schema could not hold,
	// and the surface rows they point at are left where they are rather than
	// being deleted by a rollback.
	debug.log('migration', 'Narrowing integration_projections primary key...');
	db.exec('PRAGMA foreign_keys = OFF;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_projections_old (
			account_id   TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			capability   TEXT NOT NULL,
			target_kind  TEXT NOT NULL,
			target_id    TEXT NOT NULL,
			adopted      INTEGER NOT NULL DEFAULT 0,
			restore_json TEXT,
			created_at   TEXT NOT NULL,
			PRIMARY KEY (account_id, capability, target_kind)
		)
	`);

	db.exec(`
		INSERT OR IGNORE INTO integration_projections_old (
			account_id, capability, target_kind, target_id, adopted, restore_json, created_at
		)
		SELECT account_id, capability, target_kind, target_id, adopted, restore_json, created_at
		FROM integration_projections
		ORDER BY created_at ASC;
	`);

	db.exec('DROP TABLE integration_projections;');
	db.exec('ALTER TABLE integration_projections_old RENAME TO integration_projections;');

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_projections_target
		ON integration_projections(target_kind, target_id)
	`);

	db.exec('PRAGMA foreign_keys = ON;');

	debug.log('migration', 'integration_db_links migration rolled back');
};
