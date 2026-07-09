/**
 * Profile Queries
 *
 * CRUD for reusable Profiles (Settings → Profiles) — named bundles that
 * reference existing artifacts (Skills, Commands, Subagents, MCP Connectors) by
 * their stable slug. The `profiles` table holds only the bundle metadata; the
 * `profile_items` table holds the (artifact_type, ref) references. Neither
 * duplicates artifact data — see migration 050.
 *
 * Instance-global + admin-managed (no `user_id`), mirroring
 * `skills` / `mcp_servers` / `subagents` / `permission_sets`.
 */

import { getDatabase } from '../index';

/** Artifact kinds a profile can bundle. Permissions are handled separately
 *  (they are a per-engine allow/deny overlay, not a slug-referenced artifact). */
export type ProfileItemType = 'skill' | 'command' | 'subagent' | 'mcp';

export const PROFILE_ITEM_TYPES: ProfileItemType[] = ['skill', 'command', 'subagent', 'mcp'];

export interface ProfileRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	created_at: string;
	updated_at: string;
}

export interface ProfileItemRow {
	id: number;
	profile_id: number;
	artifact_type: ProfileItemType;
	ref: string;
}

export interface ProfileInput {
	slug: string;
	name: string;
	description?: string;
}

/** One reference inside a profile. */
export interface ProfileItemInput {
	artifactType: ProfileItemType;
	ref: string;
}

export const profileQueries = {
	getAll(): ProfileRow[] {
		return getDatabase().prepare(`SELECT * FROM profiles ORDER BY created_at ASC`).all() as ProfileRow[];
	},

	getById(id: number): ProfileRow | null {
		return getDatabase().prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as ProfileRow | null;
	},

	getBySlug(slug: string): ProfileRow | null {
		return getDatabase().prepare(`SELECT * FROM profiles WHERE slug = ?`).get(slug) as ProfileRow | null;
	},

	insert(input: ProfileInput): ProfileRow {
		const result = getDatabase().prepare(
			`INSERT INTO profiles (slug, name, description) VALUES (?, ?, ?)`
		).run(input.slug, input.name, input.description ?? '') as { lastInsertRowid: number | bigint };
		return this.getById(Number(result.lastInsertRowid))!;
	},

	updateMeta(id: number, name: string, description: string): void {
		getDatabase().prepare(
			`UPDATE profiles SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
		).run(name, description, id);
	},

	remove(id: number): void {
		const db = getDatabase();
		// profile_items has ON DELETE CASCADE, but foreign-key enforcement is not
		// guaranteed on across every SQLite handle — delete items explicitly too.
		db.prepare(`DELETE FROM profile_items WHERE profile_id = ?`).run(id);
		db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
	},

	// ── Items ────────────────────────────────────────────────────────────────

	getItems(profileId: number): ProfileItemRow[] {
		return getDatabase()
			.prepare(`SELECT * FROM profile_items WHERE profile_id = ? ORDER BY artifact_type ASC, ref ASC`)
			.all(profileId) as ProfileItemRow[];
	},

	/** Whether ANY profile references this artifact (by type + slug). Used to let a
	 *  profile-activated but globally-disabled artifact through its enable gate. */
	isArtifactReferenced(type: ProfileItemType, ref: string): boolean {
		const row = getDatabase()
			.prepare(`SELECT 1 AS ok FROM profile_items WHERE artifact_type = ? AND ref = ? LIMIT 1`)
			.get(type, ref) as { ok: number } | undefined;
		return !!row;
	},

	/** Refs of one artifact type inside a profile (used by the stream-time filter). */
	getRefsByType(profileId: number, type: ProfileItemType): string[] {
		const rows = getDatabase()
			.prepare(`SELECT ref FROM profile_items WHERE profile_id = ? AND artifact_type = ?`)
			.all(profileId, type) as { ref: string }[];
		return rows.map(r => r.ref);
	},

	/** Replace a profile's entire item set (delete-then-insert). */
	setItems(profileId: number, items: ProfileItemInput[]): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM profile_items WHERE profile_id = ?`).run(profileId);
		const insert = db.prepare(
			`INSERT OR IGNORE INTO profile_items (profile_id, artifact_type, ref) VALUES (?, ?, ?)`
		);
		for (const item of items) insert.run(profileId, item.artifactType, item.ref);
	}
};
