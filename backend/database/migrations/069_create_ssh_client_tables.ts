import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create ssh_connections, ssh_known_hosts and ssh_port_forwards tables';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating ssh_connections table...');

	// `jump_connection_id` self-references: a saved host can be reached through
	// another saved host (ProxyJump). ON DELETE SET NULL rather than CASCADE —
	// deleting a bastion must not silently delete everything behind it.
	db.exec(`
		CREATE TABLE IF NOT EXISTS ssh_connections (
			id                 TEXT PRIMARY KEY,
			name               TEXT NOT NULL,
			host               TEXT NOT NULL,
			port               INTEGER NOT NULL DEFAULT 22,
			username           TEXT NOT NULL,
			auth_method        TEXT NOT NULL DEFAULT 'password'
			                   CHECK (auth_method IN ('password','key','key-file','agent')),
			password           TEXT,
			private_key        TEXT,
			private_key_path   TEXT,
			passphrase         TEXT,
			agent_socket       TEXT,
			jump_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
			initial_path       TEXT,
			keepalive_seconds  INTEGER NOT NULL DEFAULT 30,
			strict_host_key    INTEGER NOT NULL DEFAULT 1,
			color              TEXT,
			owner_user_id      TEXT,
			created_at         TEXT NOT NULL,
			updated_at         TEXT NOT NULL,
			last_used_at       TEXT
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_ssh_conn_last_used
		ON ssh_connections(last_used_at DESC)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_ssh_conn_owner
		ON ssh_connections(owner_user_id)
	`);

	debug.log('migration', 'Creating ssh_known_hosts table...');

	// One trusted key per (host, port) — the same rule OpenSSH's known_hosts
	// enforces, so a rotated key is an update rather than a second row.
	db.exec(`
		CREATE TABLE IF NOT EXISTS ssh_known_hosts (
			id           TEXT PRIMARY KEY,
			host         TEXT NOT NULL,
			port         INTEGER NOT NULL DEFAULT 22,
			key_type     TEXT NOT NULL,
			fingerprint  TEXT NOT NULL,
			added_at     TEXT NOT NULL,
			last_seen_at TEXT,
			UNIQUE (host, port)
		)
	`);

	debug.log('migration', 'Creating ssh_port_forwards table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS ssh_port_forwards (
			id            TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			name          TEXT NOT NULL,
			type          TEXT NOT NULL CHECK (type IN ('local','remote','dynamic')),
			listen_host   TEXT NOT NULL DEFAULT '127.0.0.1',
			listen_port   INTEGER NOT NULL,
			dest_host     TEXT,
			dest_port     INTEGER,
			auto_start    INTEGER NOT NULL DEFAULT 0,
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			FOREIGN KEY (connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_ssh_forward_connection
		ON ssh_port_forwards(connection_id)
	`);

	// Let a database connection reuse a saved SSH host instead of repeating the
	// host, credentials and key inline. The inline columns stay: existing
	// connections keep working untouched, and this is simply the other mode.
	const dbClientColumns = db.prepare(`PRAGMA table_info(db_client_connections)`).all() as Array<{ name: string }>;
	if (dbClientColumns.length > 0 && !dbClientColumns.some((column) => column.name === 'ssh_connection_id')) {
		debug.log('migration', 'Adding ssh_connection_id to db_client_connections...');
		db.exec(`
			ALTER TABLE db_client_connections
			ADD COLUMN ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL
		`);
	}

	debug.log('migration', 'ssh-client tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping ssh-client tables...');
	db.exec('DROP INDEX IF EXISTS idx_ssh_forward_connection');
	db.exec('DROP TABLE IF EXISTS ssh_port_forwards');
	db.exec('DROP TABLE IF EXISTS ssh_known_hosts');
	db.exec('DROP INDEX IF EXISTS idx_ssh_conn_owner');
	db.exec('DROP INDEX IF EXISTS idx_ssh_conn_last_used');
	db.exec('DROP TABLE IF EXISTS ssh_connections');
	// db_client_connections.ssh_connection_id is deliberately left in place —
	// SQLite cannot drop a column without rebuilding the table, and an orphaned
	// nullable column is harmless.
	debug.log('migration', 'ssh-client tables dropped');
};
