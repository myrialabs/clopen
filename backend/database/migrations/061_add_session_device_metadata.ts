import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add user_agent + ip_address to auth_sessions for device identification';

/**
 * Records which device/browser and IP each session was created from, so the
 * "Your Devices" / Remote Access views can show a real picture ("Chrome on
 * macOS · 1.2.3.4") instead of an opaque session id. Nullable — pre-existing
 * sessions and no-auth sessions simply have no metadata.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding device metadata columns to auth_sessions...');
	db.exec(`ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT`);
	db.exec(`ALTER TABLE auth_sessions ADD COLUMN ip_address TEXT`);
	debug.log('migration', 'auth_sessions device metadata columns added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing device metadata columns from auth_sessions...');
	// SQLite pre-3.35 can't DROP COLUMN; recreate without the columns.
	db.exec(`
		CREATE TABLE auth_sessions_new (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		INSERT INTO auth_sessions_new (id, user_id, token_hash, expires_at, created_at, last_active_at)
		SELECT id, user_id, token_hash, expires_at, created_at, last_active_at FROM auth_sessions
	`);
	db.exec(`DROP TABLE auth_sessions`);
	db.exec(`ALTER TABLE auth_sessions_new RENAME TO auth_sessions`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)`);
	debug.log('migration', 'auth_sessions device metadata columns removed');
};
