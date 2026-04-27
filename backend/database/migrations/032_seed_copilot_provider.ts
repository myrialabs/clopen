import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Seed GitHub Copilot provider into engine_providers';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding GitHub Copilot provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('copilot', 'github', 'GitHub', NULL, NULL, '{}', 1)
	`);
	debug.log('migration', 'GitHub Copilot provider seeded');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing GitHub Copilot provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'copilot' AND slug = 'github'`);
	debug.log('migration', 'GitHub Copilot provider removed');
};
