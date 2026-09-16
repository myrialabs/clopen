/**
 * Skill Queries
 *
 * CRUD for user-managed Agent Skills — the single artifact behind both model-
 * invoked skills and user-invoked `/slash` prompts (Settings → Skills). The
 * `skills` table holds only METADATA + the enable toggle; the actual SKILL.md
 * (and any bundled resources) live on disk in the canonical store under
 * `{clopenDir}/skills/<slug>/` (see `backend/skills/store.ts`).
 *
 * Conventions:
 *   - `slug`     : unique machine id, matches the on-disk folder name and the
 *                  SKILL.md `name` frontmatter. Only `[a-z0-9-]`.
 *   - `source`   : where the skill came from — 'custom' (created in-app),
 *                  'imported' (pasted/uploaded), or 'marketplace' (installed
 *                  from a provider).
 *   - `triggers` : comma list of how the skill can be invoked — `auto` (the
 *                  model decides, from the description) and/or `slash` (the user
 *                  types `/<slug>`). Migration 079 folded the old `commands`
 *                  table in as `slash`-triggered skills.
 *   - `uses`     : JSON array of sibling slugs force-loaded whenever this skill
 *                  runs, so one invocation can pull in several skills at once.
 */

import { getDatabase } from '../index';

export type SkillSource = 'custom' | 'imported' | 'marketplace';

/** How a skill can be invoked. */
export type SkillTrigger = 'auto' | 'slash';

export const SKILL_TRIGGERS: SkillTrigger[] = ['auto', 'slash'];

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
	/** Comma-separated {@link SkillTrigger} list; never empty (defaults to `auto`). */
	triggers: string;
	/** Argument hint shown beside `/slug` in the chat picker (slash skills). */
	argument_hint: string | null;
	/** JSON array of sibling slugs force-loaded with this skill. */
	uses: string;
}

export interface SkillInput {
	slug: string;
	name: string;
	description: string;
	source?: SkillSource;
	marketplaceRef?: string | null;
	version?: string | null;
	license?: string | null;
	/** Comma-separated trigger list; defaults to `auto`. */
	triggers?: string;
	argumentHint?: string | null;
	/** JSON string: array of slugs. */
	uses?: string;
}

/** Parse the stored comma list into triggers, tolerating blanks/unknown values. */
export function parseTriggers(raw: string | null | undefined): SkillTrigger[] {
	const list = (raw ?? '')
		.split(',')
		.map(t => t.trim().toLowerCase())
		.filter((t): t is SkillTrigger => SKILL_TRIGGERS.includes(t as SkillTrigger));
	// A skill with no recognised trigger would be invocable by nobody — fall back
	// to the historical default rather than silently disappearing.
	return list.length > 0 ? Array.from(new Set(list)) : ['auto'];
}

/** Serialize triggers back to the stored comma list (canonical order). */
export function stringifyTriggers(triggers: SkillTrigger[] | undefined): string {
	const set = new Set(triggers ?? []);
	const ordered = SKILL_TRIGGERS.filter(t => set.has(t));
	return (ordered.length > 0 ? ordered : ['auto']).join(',');
}

/** Parse the stored `uses` JSON array, tolerating null/blank/corrupt values. */
export function parseUses(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return Array.from(new Set(parsed.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim())));
	} catch {
		return [];
	}
}

/** Serialize a `uses` list to its stored JSON form. */
export function stringifyUses(uses: string[] | undefined): string {
	return JSON.stringify(Array.from(new Set((uses ?? []).map(u => u.trim()).filter(Boolean))));
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
			`INSERT INTO skills (slug, name, description, source, marketplace_ref, version, license, triggers, argument_hint, uses)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description,
			input.source ?? 'custom',
			input.marketplaceRef ?? null,
			input.version ?? null,
			input.license ?? null,
			input.triggers ?? 'auto',
			input.argumentHint ?? null,
			input.uses ?? '[]'
		) as { lastInsertRowid: number | bigint };
		const id = Number(result.lastInsertRowid);
		return this.getById(id)!;
	},

	/** Update every editable field of a skill (the SKILL.md itself is rewritten by the service). */
	updateMeta(
		id: number,
		fields: {
			name: string;
			description: string;
			license: string | null;
			triggers: string;
			argumentHint: string | null;
			uses: string;
		}
	): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE skills
			 SET name = ?, description = ?, license = ?, triggers = ?, argument_hint = ?, uses = ?
			 WHERE id = ?`
		).run(
			fields.name,
			fields.description,
			fields.license,
			fields.triggers,
			fields.argumentHint,
			fields.uses,
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
