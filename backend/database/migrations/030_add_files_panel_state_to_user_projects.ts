import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add files_panel_state to user_projects for files panel restore';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding files_panel_state to user_projects...');
	db.exec(`ALTER TABLE user_projects ADD COLUMN files_panel_state TEXT`);
	debug.log('migration', 'files_panel_state column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing files_panel_state from user_projects...');
	db.exec(`
		CREATE TABLE user_projects_backup AS
		SELECT user_id, project_id, joined_at, current_session_id FROM user_projects
	`);
	db.exec(`DROP TABLE user_projects`);
	db.exec(`
		CREATE TABLE user_projects (
			user_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			joined_at TEXT NOT NULL,
			current_session_id TEXT,
			PRIMARY KEY (user_id, project_id),
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
		)
	`);
	db.exec(`INSERT INTO user_projects SELECT * FROM user_projects_backup`);
	db.exec(`DROP TABLE user_projects_backup`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_user_id ON user_projects(user_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_project_id ON user_projects(project_id)`);
	debug.log('migration', 'files_panel_state column removed');
};
