import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add oauth column to mcp_servers (centralized OAuth client registration + tokens)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding oauth column to mcp_servers...');
	// Holds the JSON OAuth state Clopen manages on the user's behalf: dynamic
	// client registration + access/refresh tokens. NULL = no OAuth. Kept separate
	// from the user-editable `headers` so a refreshed token never clobbers manual
	// config, and so every engine can be handed `Authorization: Bearer <token>`.
	db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth TEXT`);
	debug.log('migration', 'oauth column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping oauth column from mcp_servers...');
	db.exec('ALTER TABLE mcp_servers DROP COLUMN oauth');
	debug.log('migration', 'oauth column dropped');
};
