import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add reasoning_effort column to chat_sessions for per-session reasoning/thinking level';

/**
 * Persists the reasoning/thinking level chosen per chat session (native per
 * engine — e.g. Codex `high`, Copilot `medium`, Pi `low`). Nullable: a NULL
 * value means "use the engine's own default", which is the behaviour for every
 * pre-existing session and any engine/model that exposes no reasoning knob.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding reasoning_effort column to chat_sessions...');
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT`);
	debug.log('migration', 'chat_sessions reasoning_effort column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing reasoning_effort column from chat_sessions...');
	// SQLite pre-3.35 can't DROP COLUMN reliably in all builds; use the guarded
	// form so the down migration is a no-op where DROP COLUMN is unsupported.
	try {
		db.exec(`ALTER TABLE chat_sessions DROP COLUMN reasoning_effort`);
	} catch {
		debug.warn('migration', 'DROP COLUMN reasoning_effort unsupported on this SQLite build — leaving column in place');
	}
	debug.log('migration', 'chat_sessions reasoning_effort column removed');
};
