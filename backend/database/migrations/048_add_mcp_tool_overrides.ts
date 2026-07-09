import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add tool_overrides column to mcp_servers (per-tool + per-engine exposure control)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding tool_overrides column to mcp_servers...');
	// Per-tool exposure state, keyed by the upstream tool's bare name. Holds a
	// JSON map `{ "<tool>": { enabled?, engines? } }`: `enabled: false` disables a
	// tool on every engine, and `engines: { "<engine>": false }` hides it from one
	// engine only. An absent entry (the default) means the tool is exposed
	// everywhere — so an empty `{}` preserves the pre-migration "all tools on"
	// behaviour. The filter is enforced in the `/mcp/ext/<slug>` proxy bridge
	// (see backend/mcp/external/proxy.ts) so it applies identically to every engine.
	db.exec(`ALTER TABLE mcp_servers ADD COLUMN tool_overrides TEXT NOT NULL DEFAULT '{}'`);
	debug.log('migration', 'tool_overrides column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping tool_overrides column from mcp_servers...');
	db.exec('ALTER TABLE mcp_servers DROP COLUMN tool_overrides');
	debug.log('migration', 'tool_overrides column dropped');
};
