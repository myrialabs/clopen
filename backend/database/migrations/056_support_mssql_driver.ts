import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Support mssql driver in db_client_connections CHECK constraint';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Updating CHECK constraint for mssql support in db_client_connections...');

	// Recreate table to update driver CHECK constraint in SQLite
	db.exec('PRAGMA foreign_keys = OFF;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_client_connections_new (
			id              TEXT PRIMARY KEY,
			name            TEXT NOT NULL,
			driver          TEXT NOT NULL CHECK (driver IN ('mysql','postgres','sqlite','mongodb','redis','mssql')),
			host            TEXT,
			port            INTEGER,
			username        TEXT,
			password        TEXT,
			database        TEXT,
			ssl_mode        TEXT DEFAULT 'disable' CHECK (ssl_mode IN ('disable','require','verify-ca','verify-full')),
			ssl_ca          TEXT,
			ssh_enabled     INTEGER NOT NULL DEFAULT 0,
			ssh_host        TEXT,
			ssh_port        INTEGER DEFAULT 22,
			ssh_username    TEXT,
			ssh_auth_method TEXT DEFAULT 'password' CHECK (ssh_auth_method IN ('password','key')),
			ssh_password    TEXT,
			ssh_private_key TEXT,
			ssh_passphrase  TEXT,
			options_json    TEXT,
			color           TEXT,
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL,
			last_used_at    TEXT,
			owner_user_id   TEXT
		)
	`);

	db.exec(`
		INSERT INTO db_client_connections_new (
			id, name, driver, host, port, username, password, database, ssl_mode, ssl_ca,
			ssh_enabled, ssh_host, ssh_port, ssh_username, ssh_auth_method, ssh_password,
			ssh_private_key, ssh_passphrase, options_json, color, created_at, updated_at,
			last_used_at, owner_user_id
		)
		SELECT
			id, name, driver, host, port, username, password, database, ssl_mode, ssl_ca,
			ssh_enabled, ssh_host, ssh_port, ssh_username, ssh_auth_method, ssh_password,
			ssh_private_key, ssh_passphrase, options_json, color, created_at, updated_at,
			last_used_at, owner_user_id
		FROM db_client_connections;
	`);

	db.exec('DROP TABLE db_client_connections;');
	db.exec('ALTER TABLE db_client_connections_new RENAME TO db_client_connections;');

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_last_used
		ON db_client_connections(last_used_at DESC)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_owner
		ON db_client_connections(owner_user_id)
	`);

	db.exec('PRAGMA foreign_keys = ON;');
	debug.log('migration', 'CHECK constraint updated successfully');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Rolling back mssql support in CHECK constraint...');
	db.exec('PRAGMA foreign_keys = OFF;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_client_connections_new (
			id              TEXT PRIMARY KEY,
			name            TEXT NOT NULL,
			driver          TEXT NOT NULL CHECK (driver IN ('mysql','postgres','sqlite','mongodb','redis')),
			host            TEXT,
			port            INTEGER,
			username        TEXT,
			password        TEXT,
			database        TEXT,
			ssl_mode        TEXT DEFAULT 'disable' CHECK (ssl_mode IN ('disable','require','verify-ca','verify-full')),
			ssl_ca          TEXT,
			ssh_enabled     INTEGER NOT NULL DEFAULT 0,
			ssh_host        TEXT,
			ssh_port        INTEGER DEFAULT 22,
			ssh_username    TEXT,
			ssh_auth_method TEXT DEFAULT 'password' CHECK (ssh_auth_method IN ('password','key')),
			ssh_password    TEXT,
			ssh_private_key TEXT,
			ssh_passphrase  TEXT,
			options_json    TEXT,
			color           TEXT,
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL,
			last_used_at    TEXT,
			owner_user_id   TEXT
		)
	`);

	db.exec(`
		INSERT INTO db_client_connections_new (
			id, name, driver, host, port, username, password, database, ssl_mode, ssl_ca,
			ssh_enabled, ssh_host, ssh_port, ssh_username, ssh_auth_method, ssh_password,
			ssh_private_key, ssh_passphrase, options_json, color, created_at, updated_at,
			last_used_at, owner_user_id
		)
		SELECT
			id, name, driver, host, port, username, password, database, ssl_mode, ssl_ca,
			ssh_enabled, ssh_host, ssh_port, ssh_username, ssh_auth_method, ssh_password,
			ssh_private_key, ssh_passphrase, options_json, color, created_at, updated_at,
			last_used_at, owner_user_id
		FROM db_client_connections
		WHERE driver != 'mssql';
	`);

	db.exec('DROP TABLE db_client_connections;');
	db.exec('ALTER TABLE db_client_connections_new RENAME TO db_client_connections;');

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_last_used
		ON db_client_connections(last_used_at DESC)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_owner
		ON db_client_connections(owner_user_id)
	`);

	db.exec('PRAGMA foreign_keys = ON;');
	debug.log('migration', 'Rollback completed');
};
