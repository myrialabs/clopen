import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create device_codes table for one-time device-pairing sign-in (Remote Access)';

/**
 * Device codes back the "Add a device" flow in Remote Access: an authenticated
 * user mints a single-use code (short TTL), embeds it in a share link/QR, and
 * the scanning device exchanges it for a normal auth session as the same user.
 * The code is burned on claim (`claimed_at`) so a leaked link is useless once
 * used or expired. Cleaned up alongside expired auth sessions.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating device_codes table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS device_codes (
			id TEXT PRIMARY KEY,
			code_hash TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			label TEXT,
			expires_at TEXT NOT NULL,
			claimed_at TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_device_codes_user ON device_codes(user_id)`);

	debug.log('migration', 'device_codes table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping device_codes table...');
	db.exec('DROP TABLE IF EXISTS device_codes');
	debug.log('migration', 'device_codes table dropped');
};
