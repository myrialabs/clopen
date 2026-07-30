import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add source column to auth_sessions to record how each session was created';

/**
 * Records the provenance of every session ('setup' | 'invite' | 'device-link' |
 * 'login' | 'pat' | 'no-auth') so the admin "Connected devices" view can show
 * where each signed-in device came from. Nullable — pre-existing sessions simply
 * have no recorded source.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding source column to auth_sessions...');
	db.exec(`ALTER TABLE auth_sessions ADD COLUMN source TEXT`);
	debug.log('migration', 'auth_sessions source column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing source column from auth_sessions...');
	// SQLite pre-3.35 can't DROP COLUMN; recreate without it (keeping 061's columns).
	db.exec(`
		CREATE TABLE auth_sessions_new (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			user_agent TEXT,
			ip_address TEXT,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		INSERT INTO auth_sessions_new (id, user_id, token_hash, expires_at, created_at, last_active_at, user_agent, ip_address)
		SELECT id, user_id, token_hash, expires_at, created_at, last_active_at, user_agent, ip_address FROM auth_sessions
	`);
	db.exec(`DROP TABLE auth_sessions`);
	db.exec(`ALTER TABLE auth_sessions_new RENAME TO auth_sessions`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)`);
	debug.log('migration', 'auth_sessions source column removed');
};
