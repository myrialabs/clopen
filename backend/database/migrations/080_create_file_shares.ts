import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create file_shares table for shareable single-file links';

/**
 * File shares back "Share Link…" in the File Explorer: an authenticated user
 * mints a link for one file, embeds it in a link/QR, and the receiving device
 * opens exactly that file without signing in.
 *
 * Stored in SQLite rather than process memory for the same reason
 * `device_codes` is (migration 060): the token is a bearer credential, so a
 * restart must not silently invalidate links a user already handed out. Only
 * the SHA-256 hash is kept.
 *
 * Two knobs the creator chooses per link:
 * - `one_time` — burn on the first open (the default), or stay openable.
 * - `expires_at` — a deadline, or NULL for a link that only a revoke ends.
 *
 * `consumed_at` is the one-time burn, set exactly once by a conditional
 * UPDATE, so concurrent opens cannot both win. `consumer_hash` binds the short
 * streaming-continuation window (byte ranges from an already-open media
 * player) to the client that burned the link, so a leaked URL cannot be
 * range-read by anyone else afterwards. `open_count` / `last_opened_at` track
 * use for both modes, which is what the management list reports.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating file_shares table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS file_shares (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			file_path TEXT NOT NULL,
			created_by TEXT NOT NULL,
			one_time INTEGER NOT NULL DEFAULT 1,
			expires_at TEXT,
			consumed_at TEXT,
			consumer_hash TEXT,
			open_count INTEGER NOT NULL DEFAULT 0,
			last_opened_at TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
		)
	`);

	// `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was.
	// A database that already holds a `file_shares` from an earlier revision of
	// this migration would therefore keep the older shape and fail at runtime —
	// missing `one_time`, and a NOT NULL `expires_at` that rejects the
	// "until revoked" links this version allows. SQLite cannot relax a column
	// constraint in place, so the table is rebuilt (rows carried over, older
	// rows defaulting to the strict one-time behaviour) rather than patched.
	const columns = db.prepare('PRAGMA table_info(file_shares)').all() as { name: string; notnull: number }[];
	const names = new Set(columns.map((c) => c.name));
	const expiresAt = columns.find((c) => c.name === 'expires_at');
	const needsRebuild =
		!names.has('one_time') ||
		!names.has('open_count') ||
		!names.has('last_opened_at') ||
		expiresAt?.notnull === 1;

	if (needsRebuild) {
		debug.log('migration', 'file_shares: rebuilding an out-of-date table shape...');
		db.exec('DROP TABLE IF EXISTS file_shares_rebuilt');
		db.exec(`
			CREATE TABLE file_shares_rebuilt (
				id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				file_path TEXT NOT NULL,
				created_by TEXT NOT NULL,
				one_time INTEGER NOT NULL DEFAULT 1,
				expires_at TEXT,
				consumed_at TEXT,
				consumer_hash TEXT,
				open_count INTEGER NOT NULL DEFAULT 0,
				last_opened_at TEXT,
				created_at TEXT NOT NULL,
				FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			INSERT INTO file_shares_rebuilt (
				id, token_hash, file_path, created_by, one_time, expires_at,
				consumed_at, consumer_hash, open_count, last_opened_at, created_at
			)
			SELECT
				id, token_hash, file_path, created_by,
				${names.has('one_time') ? 'one_time' : '1'},
				expires_at, consumed_at,
				${names.has('consumer_hash') ? 'consumer_hash' : 'NULL'},
				${names.has('open_count') ? 'open_count' : '0'},
				${names.has('last_opened_at') ? 'last_opened_at' : 'NULL'},
				created_at
			FROM file_shares
		`);
		db.exec('DROP TABLE file_shares');
		db.exec('ALTER TABLE file_shares_rebuilt RENAME TO file_shares');
	}

	db.exec(`CREATE INDEX IF NOT EXISTS idx_file_shares_user ON file_shares(created_by)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_file_shares_expires ON file_shares(expires_at)`);

	debug.log('migration', 'file_shares table ready');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping file_shares table...');
	db.exec('DROP TABLE IF EXISTS file_shares');
	debug.log('migration', 'file_shares table dropped');
};
