import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add project_ids to invite_tokens for pre-assigning project access at invite time';

/**
 * Lets an admin pick which projects a new member should get *when generating the
 * invite*, so access is already set the moment they join — no separate trip to
 * the member's project settings. Stored as a JSON array of project ids; null /
 * empty means "no projects pre-assigned".
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding project_ids column to invite_tokens...');
	db.exec(`ALTER TABLE invite_tokens ADD COLUMN project_ids TEXT`);
	debug.log('migration', 'invite_tokens project_ids column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing project_ids column from invite_tokens...');
	// SQLite pre-3.35 can't DROP COLUMN; recreate without it.
	db.exec(`
		CREATE TABLE invite_tokens_new (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
			label TEXT,
			created_by TEXT NOT NULL,
			max_uses INTEGER NOT NULL DEFAULT 1,
			use_count INTEGER NOT NULL DEFAULT 0,
			expires_at TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		INSERT INTO invite_tokens_new (id, token_hash, role, label, created_by, max_uses, use_count, expires_at, created_at)
		SELECT id, token_hash, role, label, created_by, max_uses, use_count, expires_at, created_at FROM invite_tokens
	`);
	db.exec(`DROP TABLE invite_tokens`);
	db.exec(`ALTER TABLE invite_tokens_new RENAME TO invite_tokens`);
	debug.log('migration', 'invite_tokens project_ids column removed');
};
