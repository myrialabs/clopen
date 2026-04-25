import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create db_client_connections and db_client_query_history tables';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating db_client_connections table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_client_connections (
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
			last_used_at    TEXT
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_last_used
		ON db_client_connections(last_used_at DESC)
	`);

	debug.log('migration', 'Creating db_client_query_history table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_client_query_history (
			id            TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			user_id       TEXT,
			query         TEXT NOT NULL,
			duration_ms   INTEGER,
			row_count     INTEGER,
			status        TEXT NOT NULL CHECK (status IN ('success','error')),
			error         TEXT,
			executed_at   TEXT NOT NULL,
			FOREIGN KEY (connection_id) REFERENCES db_client_connections(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_hist_conn_time
		ON db_client_query_history(connection_id, executed_at DESC)
	`);

	debug.log('migration', 'db-client tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping db-client tables...');
	db.exec('DROP INDEX IF EXISTS idx_db_client_hist_conn_time');
	db.exec('DROP INDEX IF EXISTS idx_db_client_conn_last_used');
	db.exec('DROP TABLE IF EXISTS db_client_query_history');
	db.exec('DROP TABLE IF EXISTS db_client_connections');
	debug.log('migration', 'db-client tables dropped');
};
