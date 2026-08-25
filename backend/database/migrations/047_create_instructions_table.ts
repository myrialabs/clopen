import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create instructions table for managed project/global instruction blocks';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating instructions table...');
	// One row per scope target: the single global instruction (project_id NULL),
	// plus one row per project. `content` is the Clopen-managed block injected as
	// a marker-region into each engine's memory file (CLAUDE.md / AGENTS.md / …).
	db.exec(`
		CREATE TABLE IF NOT EXISTS instructions (
			id          INTEGER  PRIMARY KEY AUTOINCREMENT,
			scope       TEXT     NOT NULL,
			project_id  TEXT,
			content     TEXT     NOT NULL DEFAULT '',
			is_enabled  INTEGER  NOT NULL DEFAULT 1,
			updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(scope, project_id)
		)
	`);
	debug.log('migration', 'instructions table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping instructions table...');
	db.exec('DROP TABLE IF EXISTS instructions');
	debug.log('migration', 'instructions table dropped');
};
