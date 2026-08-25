import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Store command/subagent model (and subagent tools) per engine';

// Model/tools materialize differently per engine (Claude & OpenCode read a native
// frontmatter; the rest fall back to a synthetic preamble). A single value forced
// one namespace onto every engine, so we move to a per-engine JSON map keyed by
// EngineType ({} = inherit/all). Existing single values were written into the
// Claude-shaped canonical file, so they migrate into the `claude-code` slot.
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Restructuring command/subagent model & tools per engine...');

	db.exec(`ALTER TABLE commands ADD COLUMN model_by_engine TEXT NOT NULL DEFAULT '{}'`);
	db.exec(`UPDATE commands SET model_by_engine = json_object('claude-code', model) WHERE model IS NOT NULL AND model != ''`);
	db.exec(`ALTER TABLE commands DROP COLUMN model`);

	db.exec(`ALTER TABLE subagents ADD COLUMN model_by_engine TEXT NOT NULL DEFAULT '{}'`);
	db.exec(`ALTER TABLE subagents ADD COLUMN tools_by_engine TEXT NOT NULL DEFAULT '{}'`);
	db.exec(`UPDATE subagents SET model_by_engine = json_object('claude-code', model) WHERE model IS NOT NULL AND model != ''`);
	db.exec(`UPDATE subagents SET tools_by_engine = json_object('claude-code', tools) WHERE tools IS NOT NULL AND tools != ''`);
	db.exec(`ALTER TABLE subagents DROP COLUMN model`);
	db.exec(`ALTER TABLE subagents DROP COLUMN tools`);

	debug.log('migration', 'per-engine model/tools columns ready');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Reverting per-engine model/tools...');

	db.exec(`ALTER TABLE commands ADD COLUMN model TEXT`);
	db.exec(`UPDATE commands SET model = json_extract(model_by_engine, '$."claude-code"')`);
	db.exec(`ALTER TABLE commands DROP COLUMN model_by_engine`);

	db.exec(`ALTER TABLE subagents ADD COLUMN model TEXT`);
	db.exec(`ALTER TABLE subagents ADD COLUMN tools TEXT`);
	db.exec(`UPDATE subagents SET model = json_extract(model_by_engine, '$."claude-code"')`);
	db.exec(`UPDATE subagents SET tools = json_extract(tools_by_engine, '$."claude-code"')`);
	db.exec(`ALTER TABLE subagents DROP COLUMN model_by_engine`);
	db.exec(`ALTER TABLE subagents DROP COLUMN tools_by_engine`);

	debug.log('migration', 'per-engine model/tools reverted');
};
