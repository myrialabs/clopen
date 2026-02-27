import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add current_session_id to user_projects for session restore on refresh';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding current_session_id to user_projects...');
	db.exec(`ALTER TABLE user_projects ADD COLUMN current_session_id TEXT`);
	debug.log('migration', 'current_session_id column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing current_session_id from user_projects...');
	db.exec(`
		CREATE TABLE user_projects_backup AS SELECT user_id, project_id, joined_at FROM user_projects
	`);
	db.exec(`DROP TABLE user_projects`);
	db.exec(`
		CREATE TABLE user_projects (
			user_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			joined_at TEXT NOT NULL,
			PRIMARY KEY (user_id, project_id),
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
		)
	`);
	db.exec(`INSERT INTO user_projects SELECT * FROM user_projects_backup`);
	db.exec(`DROP TABLE user_projects_backup`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_user_id ON user_projects(user_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_user_projects_project_id ON user_projects(project_id)`);
	debug.log('migration', 'current_session_id column removed');
};
