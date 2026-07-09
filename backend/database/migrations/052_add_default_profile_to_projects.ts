import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add default_profile_id column to projects (shared per-project default profile)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding default_profile_id column to projects...');
	// The per-project DEFAULT profile lives on `projects` (NOT `user_projects`), so
	// it is SHARED by every collaborator of the project — the first
	// project-scoped-shared setting in the codebase (existing per-project state
	// like current_session_id / files_panel_state is per-USER on user_projects).
	// A new session with no explicit `chat_sessions.profile_id` inherits this
	// default at stream start. NULL = no default (sessions run with no profile).
	db.exec(`ALTER TABLE projects ADD COLUMN default_profile_id INTEGER DEFAULT NULL`);
	debug.log('migration', 'default_profile_id column added to projects');
};

export const down = (): void => {
	debug.log('migration', 'SQLite does not support DROP COLUMN directly, skipping...');
};
