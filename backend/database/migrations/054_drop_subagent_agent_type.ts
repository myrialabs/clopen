import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Drop unused agent_type column from subagents';

export const up = (db: DatabaseConnection): void => {
	// `agent_type` was carried in the subagent frontmatter but never consumed by
	// any engine: Claude ignores the non-standard key, OpenCode explicitly drops
	// it, and the synthetic preamble only lists name/slug/description. Delegation
	// identity is the subagent's `name`/`slug`, so the column is dead metadata.
	debug.log('migration', 'Dropping agent_type from subagents...');
	db.exec(`ALTER TABLE subagents DROP COLUMN agent_type`);
	debug.log('migration', 'subagents.agent_type dropped');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Restoring agent_type on subagents...');
	db.exec(`ALTER TABLE subagents ADD COLUMN agent_type TEXT`);
	debug.log('migration', 'subagents.agent_type restored');
};
