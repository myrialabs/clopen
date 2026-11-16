import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Add the journal, secrets and the chat timeline; rename the built-in MCP servers';

/**
 * - `journal_entries`: what happened, in order, across every chat with Clopen,
 *   every task and every automation run — the history the assistant reads so
 *   it remembers yesterday even in a new chat. Memories (decisions,
 *   preferences) stay in the memory store; this is the chronology.
 * - `secrets`: passwords, tokens and keys the owner gave Clopen, sealed with the
 *   install's master key. Memories point at them by name instead of holding
 *   the value.
 * - `assistant_timeline`: the owner's one conversation with Clopen as it is
 *   shown — what they said and the answer each turn ended with — written as
 *   turns happen so the chat opens without walking every message ever saved.
 * - The built-in MCP servers were renamed for what they do: `browser-automation`
 *   → `browser` (tool `browse`), `memory-graph` → `memory` (tool `remember`),
 *   `clopen` → `control` (tool `run`). Their rows, tool overrides, toolset items
 *   and permission rules are rewritten so nothing the owner set is lost.
 */
const RENAMES: Array<{ fromServer: string; toServer: string; fromTool: string; toTool: string }> = [
	{ fromServer: 'browser-automation', toServer: 'browser', fromTool: 'actions', toTool: 'browse' },
	{ fromServer: 'memory-graph', toServer: 'memory', fromTool: 'memory', toTool: 'remember' },
	{ fromServer: 'clopen', toServer: 'control', fromTool: 'clopen', toTool: 'run' }
];

function tableExists(db: DatabaseConnection, name: string): boolean {
	return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function hasColumn(db: DatabaseConnection, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

function renameServers(db: DatabaseConnection, direction: 'up' | 'down'): void {
	for (const rename of RENAMES) {
		const [fromServer, toServer, fromTool, toTool] =
			direction === 'up'
				? [rename.fromServer, rename.toServer, rename.fromTool, rename.toTool]
				: [rename.toServer, rename.fromServer, rename.toTool, rename.fromTool];
		const fromFull = `mcp__${fromServer}__${fromTool}`;
		const toFull = `mcp__${toServer}__${toTool}`;

		if (tableExists(db, 'mcp_servers')) {
			const target = db.prepare(`SELECT id FROM mcp_servers WHERE slug = ? AND source = 'internal'`).get(toServer);
			if (target) {
				db.prepare(`DELETE FROM mcp_servers WHERE slug = ? AND source = 'internal'`).run(fromServer);
			} else {
				db.prepare(`UPDATE mcp_servers SET slug = ? WHERE slug = ? AND source = 'internal'`).run(toServer, fromServer);
			}
			if (hasColumn(db, 'mcp_servers', 'tool_overrides')) {
				db.prepare(`UPDATE mcp_servers SET tool_overrides = REPLACE(tool_overrides, ?, ?) WHERE slug = ? AND source = 'internal'`).run(
					`"${fromTool}"`,
					`"${toTool}"`,
					toServer
				);
			}
		}
		if (tableExists(db, 'profile_items')) {
			db.prepare(`UPDATE profile_items SET ref = ? WHERE ref = ?`).run(toServer, fromServer);
			db.prepare(`UPDATE profile_items SET ref = REPLACE(ref, ?, ?) WHERE ref LIKE ?`).run(fromFull, toFull, `%${fromFull}%`);
		}
		if (tableExists(db, 'permission_sets')) {
			for (const column of ['allow', 'deny']) {
				db.prepare(`UPDATE permission_sets SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ?`).run(fromFull, toFull, `%${fromFull}%`);
			}
		}
	}
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Adding journal and secrets...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS journal_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			session_id TEXT,
			project_id TEXT,
			mission_id TEXT,
			job_id TEXT,
			created_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_created ON journal_entries(created_at DESC)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_session ON journal_entries(session_id)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS secrets (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT NOT NULL DEFAULT '',
			value TEXT NOT NULL,
			created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_used_at TEXT
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS assistant_timeline (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			sender TEXT NOT NULL CHECK (sender IN ('owner', 'clopen')),
			text TEXT NOT NULL DEFAULT '',
			attached TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_timeline_created ON assistant_timeline(created_at DESC)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_timeline_session ON assistant_timeline(session_id, created_at)`);

	renameServers(db, 'up');
	debug.log('migration', '✅ Journal, secrets and timeline added; built-in MCP servers renamed');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing journal and secrets...');
	renameServers(db, 'down');
	db.exec('DROP TABLE IF EXISTS journal_entries');
	db.exec('DROP TABLE IF EXISTS secrets');
	db.exec('DROP TABLE IF EXISTS assistant_timeline');
	debug.log('migration', '✅ Removed');
};
