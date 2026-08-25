import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add profile_id column to chat_sessions (active profile per-session)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding profile_id column to chat_sessions...');
	// The active Profile is selected PER-SESSION, sitting alongside `engine`,
	// `model_id`, and `account_id` (migrations 014/015/019) and following the same
	// persist-on-stream / restore-on-continue path. Cross-device sync is automatic
	// (it's just another session column) and each collaborator can run a different
	// profile in their own session without collision. NULL = no explicit choice →
	// the stream resolver falls back to `projects.default_profile_id`.
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN profile_id INTEGER DEFAULT NULL`);
	debug.log('migration', 'profile_id column added to chat_sessions');
};

export const down = (): void => {
	debug.log('migration', 'SQLite does not support DROP COLUMN directly, skipping...');
};
