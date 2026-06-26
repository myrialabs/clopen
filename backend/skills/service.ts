/**
 * Skill service — orchestrates the DB metadata table and the on-disk canonical
 * store for the Settings → Skills CRUD surface. The WS layer calls these; they
 * keep the `skills` table and `{clopenDir}/skills/<slug>/` in lockstep.
 */

import { skillQueries, type SkillRow, type SkillSource } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import {
	parseSkillMd,
	serializeSkillMd,
	validateFrontmatter,
	slugifySkillName,
	type ParsedSkill
} from './spec';
import {
	writeSkillMd,
	writeSkillResource,
	readSkillMd,
	deleteSkillDir,
	skillDirExists
} from './store';
import { fetchMarketplaceSkill } from './marketplace';

/** A skill as surfaced to the Settings UI (DB metadata + on-disk presence). */
export interface SkillDTO {
	id: number;
	slug: string;
	name: string;
	description: string;
	source: SkillSource;
	marketplaceRef: string | null;
	version: string | null;
	license: string | null;
	enabled: boolean;
	/** False when the DB row exists but its SKILL.md is missing on disk. */
	present: boolean;
	createdAt: string;
}

/** A previewed skill parsed from pasted/imported SKILL.md text. */
export interface ParsedSkillPreview {
	name: string;
	description: string;
	license: string | null;
	body: string;
	warnings: string[];
}

function toDTO(row: SkillRow, present: boolean): SkillDTO {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		source: row.source,
		marketplaceRef: row.marketplace_ref,
		version: row.version,
		license: row.license,
		enabled: row.is_enabled === 1,
		present,
		createdAt: row.created_at
	};
}

/** Derive a slug that doesn't collide with an existing skill. */
function uniqueSlug(base: string): string {
	const root = slugifySkillName(base);
	if (!skillQueries.getBySlug(root)) return root;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${root}-${i}`.slice(0, 64).replace(/-+$/g, '');
		if (!skillQueries.getBySlug(candidate)) return candidate;
	}
	return slugifySkillName(`${root}-${Date.now()}`);
}

/** Throw a single combined error if frontmatter validation fails. */
function assertValid(skill: ParsedSkill, expectedName: string): void {
	const result = validateFrontmatter(skill.frontmatter, expectedName);
	if (!result.valid) throw new Error(result.errors.join(' '));
}

export const skillService = {
	async list(): Promise<SkillDTO[]> {
		const rows = skillQueries.getAll();
		const presence = await Promise.all(rows.map(r => skillDirExists(r.slug)));
		return rows.map((row, i) => toDTO(row, presence[i]));
	},

	async get(id: number): Promise<{ skill: SkillDTO; body: string } | null> {
		const row = skillQueries.getById(id);
		if (!row) return null;
		const raw = await readSkillMd(row.slug);
		const body = raw ? parseSkillMd(raw).body : '';
		return { skill: toDTO(row, raw !== null), body };
	},

	/** Create a skill from in-app editor fields (name + description + markdown body). */
	async create(input: { name: string; description: string; body: string; license?: string | null }): Promise<SkillDTO> {
		const slug = uniqueSlug(input.name);
		const skill: ParsedSkill = {
			frontmatter: {
				name: slug,
				description: input.description.trim(),
				license: input.license?.trim() || undefined,
				extra: {}
			},
			body: input.body
		};
		assertValid(skill, slug);
		await writeSkillMd(slug, serializeSkillMd(skill));
		const row = skillQueries.insert({
			slug,
			name: input.name.trim(),
			description: input.description.trim(),
			source: 'custom',
			license: input.license?.trim() || null
		});
		debug.log('skills', `📦 Created skill: ${slug}`);
		return toDTO(row, true);
	},

	/** Update an existing skill's editable fields and rewrite its SKILL.md. */
	async update(id: number, input: { name: string; description: string; body: string; license?: string | null }): Promise<SkillDTO> {
		const row = skillQueries.getById(id);
		if (!row) throw new Error('Skill not found');
		// `name` (frontmatter) must keep matching the folder slug — only the
		// display name, description, license and body are editable here.
		const skill: ParsedSkill = {
			frontmatter: {
				name: row.slug,
				description: input.description.trim(),
				license: input.license?.trim() || undefined,
				extra: {}
			},
			body: input.body
		};
		assertValid(skill, row.slug);
		await writeSkillMd(row.slug, serializeSkillMd(skill));
		skillQueries.updateMeta(id, input.name.trim(), input.description.trim(), input.license?.trim() || null);
		debug.log('skills', `🔧 Updated skill: ${row.slug}`);
		return toDTO(skillQueries.getById(id)!, true);
	},

	/**
	 * Parse pasted/uploaded SKILL.md text into a reviewable preview. Nothing is
	 * persisted — the UI shows the result, then calls `import` to commit it.
	 */
	parsePreview(raw: string): ParsedSkillPreview {
		const parsed = parseSkillMd(raw);
		const warnings: string[] = [];
		const result = validateFrontmatter(parsed.frontmatter, undefined);
		if (!result.valid) warnings.push(...result.errors);
		return {
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			license: parsed.frontmatter.license ?? null,
			body: parsed.body,
			warnings
		};
	},

	/** Persist a skill from pasted/uploaded SKILL.md text. */
	async import(raw: string): Promise<SkillDTO> {
		const parsed = parseSkillMd(raw);
		const displayName = parsed.frontmatter.name || 'Imported skill';
		const slug = uniqueSlug(parsed.frontmatter.name || displayName);
		// Re-key the frontmatter `name` to the de-duped slug so it matches the folder.
		parsed.frontmatter.name = slug;
		assertValid(parsed, slug);
		await writeSkillMd(slug, serializeSkillMd(parsed));
		const row = skillQueries.insert({
			slug,
			name: displayName,
			description: parsed.frontmatter.description,
			source: 'imported',
			license: parsed.frontmatter.license ?? null
		});
		debug.log('skills', `📥 Imported skill: ${slug}`);
		return toDTO(row, true);
	},

	/**
	 * Fetch and parse a marketplace skill for review before install — nothing is
	 * persisted. Powers the install modal's prefilled detail form.
	 */
	async previewInstall(ref: string): Promise<{ name: string; description: string; license: string | null; body: string }> {
		const fetched = await fetchMarketplaceSkill(ref);
		const parsed = parseSkillMd(fetched.skillMd);
		return {
			name: parsed.frontmatter.name || ref.split(/[:/]/).pop() || 'Skill',
			description: parsed.frontmatter.description,
			license: parsed.frontmatter.license ?? null,
			body: parsed.body
		};
	},

	/**
	 * Install a skill from a marketplace provider: download its SKILL.md (+ any
	 * bundled resources), validate against the spec, and persist it under a
	 * de-duped slug with `source: 'marketplace'`. Optional `override` fields (from
	 * the install modal) replace the fetched name/description/license/body.
	 */
	async install(ref: string, override?: { name?: string; description?: string; license?: string | null; body?: string }): Promise<SkillDTO> {
		const fetched = await fetchMarketplaceSkill(ref);
		const parsed = parseSkillMd(fetched.skillMd);
		if (override?.description !== undefined) parsed.frontmatter.description = override.description.trim();
		if (override?.license !== undefined) parsed.frontmatter.license = override.license?.trim() || undefined;
		if (override?.body !== undefined) parsed.body = override.body;
		const displayName = override?.name?.trim() || parsed.frontmatter.name || ref.split(/[:/]/).pop() || 'Skill';
		const slug = uniqueSlug(parsed.frontmatter.name || displayName);
		parsed.frontmatter.name = slug;
		assertValid(parsed, slug);
		await writeSkillMd(slug, serializeSkillMd(parsed));
		for (const resource of fetched.resources) {
			await writeSkillResource(slug, resource.path, resource.content);
		}
		const row = skillQueries.insert({
			slug,
			name: displayName,
			description: parsed.frontmatter.description,
			source: 'marketplace',
			marketplaceRef: ref,
			version: parsed.frontmatter.metadata?.version ?? null,
			license: parsed.frontmatter.license ?? null
		});
		debug.log('skills', `📥 Installed marketplace skill: ${slug} (${ref})`);
		return toDTO(row, true);
	},

	toggle(id: number, enabled: boolean): SkillDTO {
		const row = skillQueries.getById(id);
		if (!row) throw new Error('Skill not found');
		skillQueries.setEnabled(id, enabled);
		return toDTO(skillQueries.getById(id)!, true);
	},

	async remove(id: number): Promise<void> {
		const row = skillQueries.getById(id);
		if (!row) throw new Error('Skill not found');
		await deleteSkillDir(row.slug);
		skillQueries.remove(id);
		debug.log('skills', `🗑️ Deleted skill: ${row.slug}`);
	}
};
