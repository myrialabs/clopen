import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create mcp_servers table for external (user-installed) MCP servers';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating mcp_servers table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_servers (
			id            INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug          TEXT     NOT NULL UNIQUE,
			name          TEXT     NOT NULL,
			description   TEXT,
			registry_name TEXT,
			version       TEXT,
			transport     TEXT     NOT NULL,
			command       TEXT,
			args          TEXT     NOT NULL DEFAULT '[]',
			env           TEXT     NOT NULL DEFAULT '{}',
			url           TEXT,
			headers       TEXT     NOT NULL DEFAULT '{}',
			source        TEXT     NOT NULL DEFAULT 'registry',
			is_enabled    INTEGER  NOT NULL DEFAULT 1,
			created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'mcp_servers table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping mcp_servers table...');
	db.exec('DROP TABLE IF EXISTS mcp_servers');
	debug.log('migration', 'mcp_servers table dropped');
};
