/**
 * Skill Queries
 *
 * CRUD for user-managed Agent Skills — the skills managed from Settings →
 * Skills. The `skills` table holds only METADATA + the enable/disable toggle;
 * the actual SKILL.md (and any bundled resources) live on disk in the canonical
 * store under `{clopenDir}/skills/<slug>/` (see `backend/skills/store.ts`).
 *
 * Conventions:
 *   - `slug`   : unique machine id, matches the on-disk folder name and the
 *                SKILL.md `name` frontmatter. Only `[a-z0-9-]`.
 *   - `source` : where the skill came from — 'custom' (created in-app),
 *                'imported' (pasted/uploaded), or 'marketplace' (installed from
 *                a provider).
 */

import { getDatabase } from '../index';

export type SkillSource = 'custom' | 'imported' | 'marketplace';

/** Raw DB row. */
export interface SkillRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	source: SkillSource;
	/** Provider reference for marketplace skills (e.g. `official:pdf-processing`), or null. */
	marketplace_ref: string | null;
	version: string | null;
	license: string | null;
	is_enabled: number;
	created_at: string;
}

export interface SkillInput {
	slug: string;
	name: string;
	description: string;
	source?: SkillSource;
	marketplaceRef?: string | null;
	version?: string | null;
	license?: string | null;
}

export const skillQueries = {
	getAll(): SkillRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM skills ORDER BY created_at ASC`).all() as SkillRow[];
	},

	getEnabled(): SkillRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM skills WHERE is_enabled = 1 ORDER BY created_at ASC`).all() as SkillRow[];
	},

	getById(id: number): SkillRow | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as SkillRow | null;
	},

	getBySlug(slug: string): SkillRow | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM skills WHERE slug = ?`).get(slug) as SkillRow | null;
	},

	insert(input: SkillInput): SkillRow {
		const db = getDatabase();
		const result = db.prepare(
			`INSERT INTO skills (slug, name, description, source, marketplace_ref, version, license)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description,
			input.source ?? 'custom',
			input.marketplaceRef ?? null,
			input.version ?? null,
			input.license ?? null
		) as { lastInsertRowid: number | bigint };
		const id = Number(result.lastInsertRowid);
		return this.getById(id)!;
	},

	/** Update the display metadata (name/description/license) of a skill. */
	updateMeta(id: number, name: string, description: string, license: string | null): void {
		const db = getDatabase();
		db.prepare(`UPDATE skills SET name = ?, description = ?, license = ? WHERE id = ?`).run(
			name,
			description,
			license,
			id
		);
	},

	setEnabled(id: number, enabled: boolean): void {
		const db = getDatabase();
		db.prepare(`UPDATE skills SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	remove(id: number): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
	}
};
