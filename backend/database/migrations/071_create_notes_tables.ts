import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create note collections, notes and note images';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating notes tables...');

	// Repair path for databases that ran a pre-release version of this
	// migration: the early `notes` table (project_id/folder_path shape) has no
	// `collection_id` column, so the index creation below would fail with
	// "no such column: collection_id". Since migrations also run per-request
	// via initializeDatabase(), that failure would break every API call, not
	// just startup. The old shape is unreadable by current code (nothing
	// references folder_path anymore) and the collections feature is
	// unreleased, so drop the legacy tables and recreate them fresh.
	const existingCols = db.prepare(`SELECT name FROM pragma_table_info('notes')`).all() as { name: string }[];
	if (existingCols.length > 0 && !existingCols.some((c) => c.name === 'collection_id')) {
		debug.warn('migration', '⚠️ Legacy notes table found (no collection_id) — recreating...');
		db.exec('DROP TABLE IF EXISTS note_images');
		db.exec('DROP TABLE IF EXISTS notes');
	}

	// Scope lives here and only here. A note inherits who may read it from its
	// collection, so there is no second copy of the scope that could disagree
	// with this one — and no note that is reachable through two different
	// permission rules.
	db.exec(`
		CREATE TABLE IF NOT EXISTS note_collections (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
			project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			CHECK (
				(scope = 'project' AND project_id IS NOT NULL) OR
				(scope = 'global' AND project_id IS NULL)
			)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_note_collections_project ON note_collections(project_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_note_collections_scope ON note_collections(scope)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			collection_id TEXT NOT NULL REFERENCES note_collections(id) ON DELETE CASCADE,
			title TEXT,
			content TEXT NOT NULL DEFAULT '',
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_notes_collection ON notes(collection_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)
	`);

	// `storage_path` is relative to the data dir with forward slashes
	// (`notes/<collectionId>/<noteId>/<uuid>-<name>`), never absolute — see
	// `backend/notes/storage.ts` for why.
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
	db.exec('DROP INDEX IF EXISTS idx_notes_collection');
	db.exec('DROP TABLE IF EXISTS notes');
	db.exec('DROP INDEX IF EXISTS idx_note_collections_scope');
	db.exec('DROP INDEX IF EXISTS idx_note_collections_project');
	db.exec('DROP TABLE IF EXISTS note_collections');
	debug.log('migration', 'Notes tables dropped');
};
