import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create prompt_templates table for storing reusable prompt templates';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating prompt_templates table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS prompt_templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			category TEXT NOT NULL,
			content TEXT NOT NULL,
			description TEXT NOT NULL,
			created_at TEXT NOT NULL,
			tags TEXT,
			usage_count INTEGER DEFAULT 0
		)
	`);

	// Create index for performance
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category)
	`);

	debug.log('migration', '✅ Prompt templates table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping prompt_templates table...');
	db.exec('DROP TABLE IF EXISTS prompt_templates');
	debug.log('migration', '✅ Prompt templates table dropped');
};
