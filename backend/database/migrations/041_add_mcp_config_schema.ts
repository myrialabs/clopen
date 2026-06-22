import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add config_schema column to mcp_servers (UI field metadata)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding config_schema column to mcp_servers...');
	db.exec(`ALTER TABLE mcp_servers ADD COLUMN config_schema TEXT NOT NULL DEFAULT '[]'`);
	debug.log('migration', 'config_schema column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping config_schema column from mcp_servers...');
	db.exec('ALTER TABLE mcp_servers DROP COLUMN config_schema');
	debug.log('migration', 'config_schema column dropped');
};
