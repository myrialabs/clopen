/**
 * Migration: Create message snapshots table for time travel feature
 * Purpose: Store file snapshots for each user message to enable restoration
 */

export const description = 'Create message snapshots table';

export function up(db: any): void {
	// Create message_snapshots table for storing project state at each message
	db.prepare(`
		CREATE TABLE IF NOT EXISTS message_snapshots (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			files_snapshot TEXT NOT NULL, -- JSON object with file paths and contents
			project_metadata TEXT, -- JSON object with project info (name, path, etc)
			created_at TEXT NOT NULL,
			FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
			FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE,
			FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
		)
	`).run();

	// Create indexes for efficient queries
	db.prepare('CREATE INDEX IF NOT EXISTS idx_message_snapshots_message_id ON message_snapshots (message_id)').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_message_snapshots_session_id ON message_snapshots (session_id)').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_message_snapshots_project_id ON message_snapshots (project_id)').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_message_snapshots_created_at ON message_snapshots (created_at)').run();

	// Create session_relationships table for tracking parent-child relationships
	db.prepare(`
		CREATE TABLE IF NOT EXISTS session_relationships (
			id TEXT PRIMARY KEY,
			parent_session_id TEXT NOT NULL,
			child_session_id TEXT NOT NULL,
			branched_from_message_id TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (parent_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE,
			FOREIGN KEY (child_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE,
			FOREIGN KEY (branched_from_message_id) REFERENCES messages (id) ON DELETE SET NULL
		)
	`).run();

	// Create indexes for session relationships
	db.prepare('CREATE INDEX IF NOT EXISTS idx_session_relationships_parent ON session_relationships (parent_session_id)').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_session_relationships_child ON session_relationships (child_session_id)').run();
}

export function down(db: any): void {
	// Drop indexes
	db.prepare('DROP INDEX IF EXISTS idx_session_relationships_child').run();
	db.prepare('DROP INDEX IF EXISTS idx_session_relationships_parent').run();
	db.prepare('DROP INDEX IF EXISTS idx_message_snapshots_created_at').run();
	db.prepare('DROP INDEX IF EXISTS idx_message_snapshots_project_id').run();
	db.prepare('DROP INDEX IF EXISTS idx_message_snapshots_session_id').run();
	db.prepare('DROP INDEX IF EXISTS idx_message_snapshots_message_id').run();

	// Drop tables
	db.prepare('DROP TABLE IF EXISTS session_relationships').run();
	db.prepare('DROP TABLE IF EXISTS message_snapshots').run();
}