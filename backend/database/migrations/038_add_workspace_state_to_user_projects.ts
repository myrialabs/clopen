import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add workspace_state to user_projects for per-project dock/layout restore';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding workspace_state to user_projects...');
	db.exec(`ALTER TABLE user_projects ADD COLUMN workspace_state TEXT`);
	debug.log('migration', 'workspace_state column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing workspace_state from user_projects...');
	db.exec(`
		CREATE TABLE user_projects_backup AS
		SELECT user_id, project_id, joined_at, current_session_id, files_panel_state FROM user_projects
	`);
	db.exec(`DROP TABLE user_projects`);
	db.exec(`ALTER TABLE user_projects_backup RENAME TO user_projects`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_user_id ON user_projects(user_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_project_id ON user_projects(project_id)`);
	debug.log('migration', 'workspace_state column removed');
};
