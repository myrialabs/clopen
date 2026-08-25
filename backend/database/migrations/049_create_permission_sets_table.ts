import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create permission_sets table for per-engine tool allow/deny rules';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating permission_sets table...');
	// One row holds the allow + deny tool lists for a single
	// `(scope, project_id, engine)` combination — the same shape decision as
	// `mcp_servers.tool_overrides` (JSON lists over a relation table). Both
	// `allow` and `deny` are JSON `string[]` of tool-name patterns (exact name or
	// a trailing-`*` wildcard, e.g. `mcp__github__*`).
	//
	// Semantics resolved per engine at stream start (see backend/permissions/resolve.ts):
	//   - deny  = global.deny ∪ project.deny        (deny always adds restriction)
	//   - allow = project.allow if non-empty, else global.allow
	//   - deny wins over allow; an empty allow means "all tools except deny".
	//
	// Instance-global + admin-managed: NO `user_id` column (mirrors skills /
	// mcp_servers / subagents). `project_id` is NULL for global-scope rows and set
	// for project-scope rows. The UNIQUE index makes save an idempotent upsert.
	db.exec(`
		CREATE TABLE IF NOT EXISTS permission_sets (
			id           INTEGER  PRIMARY KEY AUTOINCREMENT,
			scope        TEXT     NOT NULL DEFAULT 'global',
			project_id   TEXT,
			engine       TEXT     NOT NULL,
			allow        TEXT     NOT NULL DEFAULT '[]',
			deny         TEXT     NOT NULL DEFAULT '[]',
			created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	// SQLite treats every NULL as distinct in a UNIQUE index, so global-scope rows
	// (project_id IS NULL) would not be de-duplicated by a plain UNIQUE(...). Use a
	// COALESCE expression index so `(scope, '', engine)` is unique for globals while
	// project rows key on their real id.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_sets_scope
		ON permission_sets (scope, COALESCE(project_id, ''), engine)
	`);
	debug.log('migration', 'permission_sets table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping permission_sets table...');
	db.exec('DROP INDEX IF EXISTS idx_permission_sets_scope');
	db.exec('DROP TABLE IF EXISTS permission_sets');
	debug.log('migration', 'permission_sets table dropped');
};
