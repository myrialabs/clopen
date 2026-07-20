import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Seed the Cline engine provider (multi-provider via @cline/sdk)';

/**
 * Cline is Pi/Qwen-style: a single `engine_providers` row owns every Cline
 * account. Each account's `credential` blob carries the Cline provider id + auth
 * method + secret (see `backend/engine/adapters/cline/credential.ts`), so one row
 * backs Anthropic, OpenAI, Google, the Cline account, … side by side.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding Cline provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('cline', 'cline', 'Cline', '@cline/sdk', NULL, '{}', 1)
	`);
	debug.log('migration', 'Cline provider seeded');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing Cline provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'cline' AND slug = 'cline'`);
	debug.log('migration', 'Cline provider removed');
};
