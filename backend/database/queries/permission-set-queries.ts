/**
 * Permission Set Queries
 *
 * CRUD for per-engine tool allow/deny rules (Settings → Permissions). Each row
 * carries the `allow` + `deny` tool-pattern lists for one
 * `(scope, project_id, engine)` combination — see migration 049 for the resolved
 * semantics. Instance-global + admin-managed (no `user_id`), mirroring
 * `skills` / `mcp_servers` / `subagents`.
 *
 * `allow` / `deny` are stored as JSON `string[]`; callers get parsed arrays back
 * via {@link PermissionSet}. The raw JSON never leaves this module.
 */

import { getDatabase } from '../index';
import type { EngineType } from '$shared/types/unified';

export type PermissionScope = 'global' | 'project' | 'profile';

interface PermissionSetRow {
	id: number;
	scope: PermissionScope;
	project_id: string | null;
	profile_id: number | null;
	engine: EngineType;
	allow: string;
	deny: string;
	created_at: string;
	updated_at: string;
}

/** A resolved permission set with `allow`/`deny` parsed into string arrays. */
export interface PermissionSet {
	id: number;
	scope: PermissionScope;
	projectId: string | null;
	profileId: number | null;
	engine: EngineType;
	allow: string[];
	deny: string[];
}

function parseList(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

function toSet(row: PermissionSetRow): PermissionSet {
	return {
		id: row.id,
		scope: row.scope,
		projectId: row.project_id,
		profileId: row.profile_id,
		engine: row.engine,
		allow: parseList(row.allow),
		deny: parseList(row.deny)
	};
}

export const permissionSetQueries = {
	/** Every stored set (both scopes), for the Settings listing. */
	getAll(): PermissionSet[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM permission_sets ORDER BY scope ASC, engine ASC`)
			.all() as PermissionSetRow[];
		return rows.map(toSet);
	},

	/** Global-scope sets (project_id IS NULL), keyed by engine downstream. */
	getGlobal(): PermissionSet[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM permission_sets WHERE scope = 'global'`)
			.all() as PermissionSetRow[];
		return rows.map(toSet);
	},

	/** Project-scope sets for one project. */
	getForProject(projectId: string): PermissionSet[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM permission_sets WHERE scope = 'project' AND project_id = ?`)
			.all(projectId) as PermissionSetRow[];
		return rows.map(toSet);
	},

	/** Profile-scope sets for one profile (the per-profile allow/deny overlay). */
	getForProfile(profileId: number): PermissionSet[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM permission_sets WHERE scope = 'profile' AND profile_id = ?`)
			.all(profileId) as PermissionSetRow[];
		return rows.map(toSet);
	},

	/** The set for one exact (scope, project, profile, engine), or null. */
	getOne(
		scope: PermissionScope,
		projectId: string | null,
		profileId: number | null,
		engine: EngineType
	): PermissionSet | null {
		const row = getDatabase()
			.prepare(
				`SELECT * FROM permission_sets
				 WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')
				   AND COALESCE(profile_id, -1) = COALESCE(?, -1) AND engine = ?`
			)
			.get(scope, projectId, profileId, engine) as PermissionSetRow | undefined;
		return row ? toSet(row) : null;
	},

	/**
	 * Upsert the allow/deny lists for one (scope, project, profile, engine). When
	 * both lists are empty the row is deleted so the table only ever holds real
	 * rules (keeps resolution cheap and "any restriction?" a simple emptiness
	 * check). `projectId` is only kept for `scope='project'`, `profileId` only for
	 * `scope='profile'`.
	 */
	save(
		scope: PermissionScope,
		projectId: string | null,
		profileId: number | null,
		engine: EngineType,
		allow: string[],
		deny: string[]
	): void {
		const db = getDatabase();
		const normProject = scope === 'project' ? projectId : null;
		const normProfile = scope === 'profile' ? profileId : null;
		const where = `scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')
			 AND COALESCE(profile_id, -1) = COALESCE(?, -1) AND engine = ?`;
		if (allow.length === 0 && deny.length === 0) {
			db.prepare(`DELETE FROM permission_sets WHERE ${where}`)
				.run(scope, normProject, normProfile, engine);
			return;
		}
		// Explicit exists → update/insert rather than ON CONFLICT: the uniqueness
		// lives in an EXPRESSION index (COALESCE(...)), which is awkward to name as
		// an upsert conflict target across SQLite builds.
		const existing = db
			.prepare(`SELECT id FROM permission_sets WHERE ${where}`)
			.get(scope, normProject, normProfile, engine) as { id: number } | undefined;
		if (existing) {
			db.prepare(
				`UPDATE permission_sets SET allow = ?, deny = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
			).run(JSON.stringify(allow), JSON.stringify(deny), existing.id);
		} else {
			db.prepare(
				`INSERT INTO permission_sets (scope, project_id, profile_id, engine, allow, deny)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run(scope, normProject, normProfile, engine, JSON.stringify(allow), JSON.stringify(deny));
		}
	}
};
