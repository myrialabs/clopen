import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create profiles + profile_items tables (reusable artifact bundles)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating profiles tables...');
	// A profile is a NAMED, REUSABLE bundle of references to existing artifacts
	// (Skills, Commands, Subagents, MCP Connectors). It does NOT duplicate the
	// artifact data — `profile_items` only points at artifacts by their stable
	// slug, so editing/deleting an artifact never desyncs a profile's copy.
	//
	// Instance-global + admin-managed: NO `user_id` column, exactly mirroring
	// `skills` / `mcp_servers` / `subagents` / `permission_sets`. A profile is
	// shared across every collaborator and consistent cross-device; activation
	// (which profile a session uses) is tracked separately on `chat_sessions`.
	db.exec(`
		CREATE TABLE IF NOT EXISTS profiles (
			id           INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug         TEXT     NOT NULL UNIQUE,
			name         TEXT     NOT NULL,
			description  TEXT     NOT NULL DEFAULT '',
			created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);

	// One row per (profile, artifact_type, ref). `ref` is the artifact's slug —
	// stable and human-readable, and the same key Skills/Commands/Subagents use on
	// disk and MCP servers use as their bridge namespace. `ON DELETE CASCADE`
	// removes a profile's items when the profile is deleted.
	//
	// Presence-per-type semantics (resolved in backend/profiles/service.ts): a
	// profile only NARROWS the artifact types it actually references. If a profile
	// lists ≥1 item of a type, that type is filtered to those refs at stream start;
	// if it lists none of a type, that type is left unconstrained (all enabled).
	db.exec(`
		CREATE TABLE IF NOT EXISTS profile_items (
			id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
			profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
			artifact_type TEXT    NOT NULL,
			ref           TEXT    NOT NULL,
			UNIQUE(profile_id, artifact_type, ref)
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_items_profile ON profile_items (profile_id)`);

	debug.log('migration', 'profiles tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping profiles tables...');
	db.exec('DROP INDEX IF EXISTS idx_profile_items_profile');
	db.exec('DROP TABLE IF EXISTS profile_items');
	db.exec('DROP TABLE IF EXISTS profiles');
	debug.log('migration', 'profiles tables dropped');
};
