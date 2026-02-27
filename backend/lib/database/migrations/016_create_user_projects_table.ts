import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create user_projects table for per-user project lists';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating user_projects table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS user_projects (
			user_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			joined_at TEXT NOT NULL,
			PRIMARY KEY (user_id, project_id),
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_user_projects_user_id ON user_projects(user_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_user_projects_project_id ON user_projects(project_id)
	`);

	debug.log('migration', 'user_projects table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping user_projects table...');
	db.exec('DROP TABLE IF EXISTS user_projects');
	debug.log('migration', 'user_projects table dropped');
};
