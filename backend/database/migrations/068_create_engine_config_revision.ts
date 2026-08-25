import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create engine_config_revision counter + triggers that bump it on any engine-affecting config write';

/**
 * A single counter that goes up whenever anything an engine bakes at start-up
 * changes.
 *
 * This exists because the "Restart Server" button was removed. That button was
 * a manual cache-invalidation lever: Open Code spawns `opencode serve` with its
 * MCP set, provider list and agent registry frozen into the process, so editing
 * any of them left the running server serving stale config until somebody
 * noticed and pressed restart. With no button left, nothing may depend on a
 * human noticing.
 *
 * The counter is maintained by TRIGGERS rather than by a `bumpConfig()` helper
 * called from the write paths. A helper is one `git grep` away from being
 * forgotten by the next feature that adds a config table, and the failure mode
 * of forgetting it is invisible — config that silently never applies, with no
 * button to work around it. A trigger cannot be forgotten by code that does not
 * know it exists.
 *
 * Triggers are scoped with `UPDATE OF <columns>` on purpose. A blanket
 * `AFTER UPDATE` would fire on bookkeeping columns (timestamps, usage counters)
 * and bump the revision for writes that change nothing an engine reads, costing
 * a needless config rebuild on every one of them.
 *
 * The revision is only ever a cache-invalidation SIGNAL. What actually decides
 * whether a server is respawned is the hash of the config content itself (see
 * `backend/engine/adapters/opencode/server.ts`), so a bump that turns out not to
 * change any baked value — toggling a connector off and back on, editing a
 * permission rule that is enforced per-prompt rather than at boot — costs one
 * rebuild and reuses the running server.
 */

/** Tables whose rows feed engine start-up config, with the columns that matter. */
const WATCHED: { table: string; columns: string[] }[] = [
	// MCP connectors: baked into every engine's server/session config.
	// `oauth` is included because a refreshed token changes the Authorization
	// header the connector is spawned with.
	{
		table: 'mcp_servers',
		columns: ['slug', 'name', 'transport', 'command', 'args', 'env', 'url', 'headers', 'is_enabled', 'config_schema', 'oauth', 'tool_overrides'],
	},
	// Providers + accounts: Open Code receives these as OPENCODE_CONFIG_CONTENT
	// and env vars at spawn; every other engine reads them per turn.
	{
		table: 'engine_providers',
		columns: ['slug', 'name', 'npm', 'api_url', 'options', 'is_enabled'],
	},
	// Deliberately NOT `name` — renaming an account changes no baked value.
	{
		table: 'engine_accounts',
		columns: ['provider_id', 'credential', 'is_active'],
	},
	{ table: 'skills', columns: ['slug', 'name', 'description', 'is_enabled'] },
	{ table: 'commands', columns: ['slug', 'name', 'description', 'argument_hint', 'is_enabled', 'model_by_engine'] },
	{ table: 'subagents', columns: ['slug', 'name', 'description', 'is_enabled', 'model_by_engine', 'tools_by_engine'] },
	{ table: 'instructions', columns: ['scope', 'project_id', 'content', 'is_enabled'] },
	{ table: 'permission_sets', columns: ['scope', 'project_id', 'engine', 'allow', 'deny', 'profile_id'] },
	{ table: 'profiles', columns: ['slug', 'name'] },
	{ table: 'profile_items', columns: ['profile_id', 'artifact_type', 'ref'] },
];

const BUMP = `UPDATE engine_config_revision SET revision = revision + 1, updated_at = datetime('now') WHERE id = 1;`;

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating engine_config_revision table...');

	// Single-row table. The CHECK makes that a schema guarantee rather than a
	// convention the triggers have to trust.
	db.exec(`
		CREATE TABLE IF NOT EXISTS engine_config_revision (
			id         INTEGER  PRIMARY KEY CHECK (id = 1),
			revision   INTEGER  NOT NULL DEFAULT 1,
			updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
		)
	`);
	db.exec(`INSERT OR IGNORE INTO engine_config_revision (id, revision) VALUES (1, 1)`);

	for (const { table, columns } of WATCHED) {
		// A watched table may legitimately be absent on an old database that never
		// ran the migration creating it; skipping keeps this migration total.
		const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
		if (!exists) {
			debug.warn('migration', `engine_config_revision: table ${table} not present, skipping its triggers`);
			continue;
		}

		db.exec(`
			CREATE TRIGGER IF NOT EXISTS trg_engine_config_rev_${table}_ins
			AFTER INSERT ON ${table} BEGIN ${BUMP} END
		`);
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS trg_engine_config_rev_${table}_del
			AFTER DELETE ON ${table} BEGIN ${BUMP} END
		`);
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS trg_engine_config_rev_${table}_upd
			AFTER UPDATE OF ${columns.join(', ')} ON ${table} BEGIN ${BUMP} END
		`);
	}

	debug.log('migration', `engine_config_revision created with triggers on ${WATCHED.length} tables`);
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping engine_config_revision...');
	for (const { table } of WATCHED) {
		db.exec(`DROP TRIGGER IF EXISTS trg_engine_config_rev_${table}_ins`);
		db.exec(`DROP TRIGGER IF EXISTS trg_engine_config_rev_${table}_del`);
		db.exec(`DROP TRIGGER IF EXISTS trg_engine_config_rev_${table}_upd`);
	}
	db.exec('DROP TABLE IF EXISTS engine_config_revision');
	debug.log('migration', 'engine_config_revision dropped');
};
