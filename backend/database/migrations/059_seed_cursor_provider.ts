import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Seed the Cursor engine provider (@cursor/sdk, single API-key account)';

/**
 * Cursor is single-provider: one `engine_providers` row owns every Cursor
 * account. Each account's `credential` blob carries just the Cursor API key
 * (see `backend/engine/adapters/cursor/credential.ts`) — there is no per-provider
 * fan-out like Cline/Qwen.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding Cursor provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('cursor', 'cursor', 'Cursor', '@cursor/sdk', NULL, '{}', 1)
	`);
	debug.log('migration', 'Cursor provider seeded');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing Cursor provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'cursor' AND slug = 'cursor'`);
	debug.log('migration', 'Cursor provider removed');
};
