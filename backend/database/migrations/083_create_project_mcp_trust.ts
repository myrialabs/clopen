import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create project_mcp_trust for admin approval of a repository\'s .agents/mcp.json';

/**
 * A repository's `.agents/mcp.json` can start arbitrary processes, and in a
 * multi-user instance anyone who can push to the repo could otherwise make
 * Clopen run a command on the server. So project MCP servers stay inert until
 * an admin approves them.
 *
 * The approval is bound to the file's sha256, not to the project: any edit to
 * the file — including one arriving through `git pull` — produces a new hash and
 * the servers go inert again until someone re-approves the new content. One row
 * per project; approving a new version replaces the old one.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating project_mcp_trust table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS project_mcp_trust (
			project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			file_hash    TEXT NOT NULL,
			approved_by  TEXT,
			approved_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	debug.log('migration', '✅ project_mcp_trust table created');
};

export const down = (db: DatabaseConnection): void => {
	db.exec('DROP TABLE IF EXISTS project_mcp_trust');
};
