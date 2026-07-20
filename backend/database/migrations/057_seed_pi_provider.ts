import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Seed the Pi engine provider (multi-provider via pi-coding-agent)';

/**
 * Pi is Qwen-style: a single `engine_providers` row owns every Pi account. Each
 * account's `credential` blob carries the pi-ai provider id + credential (see
 * `backend/engine/adapters/pi/credential.ts`), so one row backs Anthropic,
 * OpenAI, Google, … accounts side by side.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding Pi provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('pi', 'pi', 'Pi', '@earendil-works/pi-coding-agent', NULL, '{}', 1)
	`);
	debug.log('migration', 'Pi provider seeded');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing Pi provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'pi' AND slug = 'pi'`);
	debug.log('migration', 'Pi provider removed');
};
