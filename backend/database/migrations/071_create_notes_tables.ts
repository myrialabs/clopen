import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create notes and note_images tables for project-scoped markdown notes';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating notes tables...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			folder_path TEXT,
			title TEXT,
			content TEXT NOT NULL DEFAULT '',
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_notes_project_folder ON notes(project_id, folder_path)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS note_images (
			id TEXT PRIMARY KEY,
			note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			file_name TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			size INTEGER NOT NULL,
			storage_path TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_note_images_note ON note_images(note_id)
	`);

	debug.log('migration', 'Notes tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping notes tables...');
	db.exec('DROP INDEX IF EXISTS idx_note_images_note');
	db.exec('DROP TABLE IF EXISTS note_images');
	db.exec('DROP INDEX IF EXISTS idx_notes_updated');
	db.exec('DROP INDEX IF EXISTS idx_notes_project_folder');
	db.exec('DROP INDEX IF EXISTS idx_notes_project');
	db.exec('DROP TABLE IF EXISTS notes');
	debug.log('migration', 'Notes tables dropped');
};
