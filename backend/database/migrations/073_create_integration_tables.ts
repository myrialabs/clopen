import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create integration_accounts, integration_projections and integration_webhook_deliveries';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating integration_accounts table...');

	// One row per connected third-party account, and the ONLY place that
	// account's credential lives. Everything that talks to the service reads
	// through here instead of keeping its own copy.
	//
	// `(provider, label)` is the identity: two projects pointing at different
	// orgs of the same service are two accounts with two labels, not one row
	// scoped twice. `project_id` is a BINDING on top of that identity — null
	// means the account is available to every project.
	//
	// `credentials` is sealed at rest by the query layer (see
	// backend/database/crypto). It is a JSON object because the shape differs
	// per provider, and the whole blob is sealed rather than field-by-field.
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_accounts (
			id            TEXT PRIMARY KEY,
			provider      TEXT NOT NULL,
			label         TEXT NOT NULL,
			project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
			auth_method   TEXT NOT NULL,
			credentials   TEXT NOT NULL DEFAULT '{}',
			capabilities  TEXT NOT NULL DEFAULT '[]',
			status        TEXT NOT NULL DEFAULT 'unknown'
			              CHECK (status IN ('unknown','ok','needs_auth','needs_config','error')),
			status_detail TEXT,
			checked_at    TEXT,
			is_enabled    INTEGER NOT NULL DEFAULT 1,
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			UNIQUE (provider, label)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_accounts_provider
		ON integration_accounts(provider)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_accounts_project
		ON integration_accounts(project_id)
	`);

	debug.log('migration', 'Creating integration_projections table...');

	// A projection is a row on another surface that was DERIVED from an account
	// — an `mcp_servers` row for the agent-tools capability, a
	// `db_client_connections` row for a database one. This table is the link,
	// and it is what makes re-projection and cleanup possible without any
	// surface having to know accounts exist.
	//
	// `adopted` is the whole reason this is a table rather than a naming
	// convention: when a projection lands on a slug the user had already
	// installed by hand, we take ownership of the EXISTING row instead of
	// creating a sibling, and mark it adopted so disconnecting releases it
	// rather than deleting what the user built.
	//
	// `restore_json` is what makes that release honest. Adopting a row
	// overwrites the credential the user had configured on it; without a
	// snapshot, "we left your row intact" would mean leaving behind a row
	// pointing at a credential we just deleted.
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_projections (
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
		CREATE INDEX IF NOT EXISTS idx_integration_projections_target
		ON integration_projections(target_kind, target_id)
	`);

	debug.log('migration', 'Creating integration_webhook_deliveries table...');

	// Replay rejection. The UNIQUE key is the check: an INSERT that violates it
	// IS the duplicate detection, atomically. A read-then-write would let two
	// concurrent deliveries of the same event both pass the read.
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
			provider    TEXT NOT NULL,
			delivery_id TEXT NOT NULL,
			received_at TEXT NOT NULL,
			PRIMARY KEY (provider, delivery_id)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_integration_webhook_received
		ON integration_webhook_deliveries(received_at)
	`);

	debug.log('migration', 'integration tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping integration tables...');
	db.exec('DROP INDEX IF EXISTS idx_integration_webhook_received');
	db.exec('DROP TABLE IF EXISTS integration_webhook_deliveries');
	db.exec('DROP INDEX IF EXISTS idx_integration_projections_target');
	db.exec('DROP TABLE IF EXISTS integration_projections');
	db.exec('DROP INDEX IF EXISTS idx_integration_accounts_project');
	db.exec('DROP INDEX IF EXISTS idx_integration_accounts_provider');
	db.exec('DROP TABLE IF EXISTS integration_accounts');
	debug.log('migration', 'integration tables dropped');
};
