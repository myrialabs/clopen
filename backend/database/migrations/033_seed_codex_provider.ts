import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Seed OpenAI Codex provider into engine_providers';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding OpenAI Codex provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('codex', 'openai', 'OpenAI', NULL, NULL, '{}', 1)
	`);
	debug.log('migration', 'OpenAI Codex provider seeded');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing OpenAI Codex provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'codex' AND slug = 'openai'`);
	debug.log('migration', 'OpenAI Codex provider removed');
};
