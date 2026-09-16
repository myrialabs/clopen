/**
 * Skill service — orchestrates the DB metadata table and the on-disk canonical
 * store for the Settings → Skills CRUD surface. The WS layer calls these; they
 * keep the `skills` table and `{clopenDir}/skills/<slug>/` in lockstep.
 *
 * Since migration 079 a skill covers BOTH ways of invoking a reusable prompt:
 *   - `auto`  — the model reads the description and loads the skill when it fits;
 *   - `slash` — the user types `/<slug>` and Clopen expands the body into the
 *     prompt (see `./invoke.ts`). This is what the old Commands feature was.
 * The two are independent switches, so one skill can be both.
 */

import {
	skillQueries,
	parseTriggers,
	stringifyTriggers,
	parseUses,
	stringifyUses,
	type SkillRow,
	type SkillSource,
	type SkillTrigger
} from '$backend/database/queries';
import { uniqueSlug } from '$backend/artifacts';
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
	/** How the skill can be invoked — `auto` and/or `slash`. Never empty. */
	triggers: SkillTrigger[];
	/** Argument hint shown beside `/slug` in the chat picker. */
	argumentHint: string | null;
	/** Sibling slugs force-loaded whenever this skill runs. */
	uses: string[];
	enabled: boolean;
	/** False when the DB row exists but its SKILL.md is missing on disk. */
	present: boolean;
	createdAt: string;
}

/** Editable fields shared by create / update. */
export interface SkillInputFields {
	/**
	 * Machine id, settable only at creation.
	 *
	 * It is the folder name on disk, the `/<slug>` a user types in chat, and what
	 * `uses:` lists and Profile bundles reference — so renaming it after the fact
	 * would break every one of those silently. Blank means "derive it from the
	 * name". {@link skillService.update} ignores this field entirely.
	 */
	slug?: string;
	name: string;
	description: string;
	body: string;
	license?: string | null;
	triggers?: SkillTrigger[];
	argumentHint?: string | null;
	uses?: string[];
}

/** A previewed skill parsed from pasted/imported SKILL.md text. */
export interface ParsedSkillPreview {
	name: string;
	description: string;
	license: string | null;
	triggers: SkillTrigger[];
	argumentHint: string | null;
	uses: string[];
	body: string;
	warnings: string[];
}

/** One slash-invocable skill as offered to the chat "/" picker. */
export interface AvailableSkill {
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
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
		triggers: parseTriggers(row.triggers),
		argumentHint: row.argument_hint,
		uses: parseUses(row.uses),
		enabled: row.is_enabled === 1,
		present,
		createdAt: row.created_at
	};
}

/** Normalise a comma list of trigger names into the validated set. */
function triggersFromFrontmatter(raw: string | undefined): SkillTrigger[] {
	return parseTriggers(raw);
}

/** `uses` round-trips through frontmatter as a comma list, and through the DB as JSON. */
function usesFromFrontmatter(raw: string | undefined): string[] {
	return (raw ?? '').split(',').map(u => u.trim()).filter(Boolean);
}

/** Build the canonical SKILL.md frontmatter for a set of editor fields. */
function frontmatterFor(slug: string, input: SkillInputFields): ParsedSkill['frontmatter'] {
	const triggers = input.triggers?.length ? input.triggers : (['auto'] as SkillTrigger[]);
	const uses = (input.uses ?? []).map(u => u.trim()).filter(Boolean);
	return {
		name: slug,
		description: input.description.trim(),
		license: input.license?.trim() || undefined,
		// `triggers` is always written, even when it is the default: an explicit
		// value is what makes an exported SKILL.md round-trip into another Clopen
		// with the same behaviour instead of silently reverting to `auto`.
		triggers: stringifyTriggers(triggers),
		argumentHint: input.argumentHint?.trim() || undefined,
		uses: uses.length ? uses.join(', ') : undefined,
		extra: {}
	};
}

/** Throw a single combined error if frontmatter validation fails. */
function assertValid(skill: ParsedSkill, expectedName: string): void {
	const result = validateFrontmatter(skill.frontmatter, expectedName);
	if (!result.valid) throw new Error(result.errors.join(' '));
}

/** Derive a slug that doesn't collide with an existing skill. */
function nextSlug(base: string): string {
	return uniqueSlug(slugifySkillName(base), s => !!skillQueries.getBySlug(s));
}

/**
 * Resolve the slug for a new skill.
 *
 * A slug the user typed is normalised but never silently de-duplicated: they
 * asked for that exact id, so a clash is reported instead of quietly becoming
 * `<slug>-2`. A derived slug keeps the old auto-suffix behaviour, because there
 * the user expressed no preference.
 */
function resolveNewSlug(input: SkillInputFields): string {
	const requested = input.slug?.trim();
	if (!requested) return nextSlug(input.name);
	const slug = slugifySkillName(requested);
	if (skillQueries.getBySlug(slug)) {
		throw new Error(`The id "${slug}" is already used by another skill. Pick a different one.`);
	}
	return slug;
}

export const skillService = {
	async list(): Promise<SkillDTO[]> {
		const rows = skillQueries.getAll();
		const presence = await Promise.all(rows.map(r => skillDirExists(r.slug)));
		return rows.map((row, i) => toDTO(row, presence[i]));
	},

	/**
	 * Minimal list of slash-invocable skills for the chat "/" picker. Non-admin
	 * surface (any user can invoke one), so it exposes only display fields — no
	 * bodies, no source/disk metadata.
	 *
	 * `profileFilter` mirrors the stream-time semantics: when an active profile
	 * references ≥1 skill, the picker shows exactly that set (even if a referenced
	 * skill is globally disabled) instead of the enabled set.
	 */
	available(profileFilter?: Set<string> | null): AvailableSkill[] {
		const rows = profileFilter
			? skillQueries.getAll().filter(r => profileFilter.has(r.slug))
			: skillQueries.getEnabled();
		return rows
			.filter(r => parseTriggers(r.triggers).includes('slash'))
			.map(r => ({
				slug: r.slug,
				name: r.name,
				description: r.description,
				argumentHint: r.argument_hint
			}));
	},

	async get(id: number): Promise<{ skill: SkillDTO; body: string } | null> {
		const row = skillQueries.getById(id);
		if (!row) return null;
		const raw = await readSkillMd(row.slug);
		const body = raw ? parseSkillMd(raw).body : '';
		return { skill: toDTO(row, raw !== null), body };
	},

	/** Create a skill from in-app editor fields. */
	async create(input: SkillInputFields): Promise<SkillDTO> {
		if (!input.name.trim()) throw new Error('A skill name is required');
		// The body IS the skill — an empty one loads nothing and runs nothing.
		if (!input.body.trim()) throw new Error('Instructions are required');
		const slug = resolveNewSlug(input);
		const skill: ParsedSkill = { frontmatter: frontmatterFor(slug, input), body: input.body };
		assertValid(skill, slug);
		await writeSkillMd(slug, serializeSkillMd(skill));
		const row = skillQueries.insert({
			slug,
			name: input.name.trim(),
			description: input.description.trim(),
			source: 'custom',
			license: input.license?.trim() || null,
			triggers: stringifyTriggers(input.triggers),
			argumentHint: input.argumentHint?.trim() || null,
			uses: stringifyUses(input.uses)
		});
		debug.log('skills', `📦 Created skill: ${slug} (${stringifyTriggers(input.triggers)})`);
		return toDTO(row, true);
	},

	/** Update an existing skill's editable fields and rewrite its SKILL.md. */
	async update(id: number, input: SkillInputFields): Promise<SkillDTO> {
		const row = skillQueries.getById(id);
		if (!row) throw new Error('Skill not found');
		if (!input.body.trim()) throw new Error('Instructions are required');
		// The slug is frozen after creation: it is the folder on disk, the `/<slug>`
		// typed in chat, and what `uses:` lists and Profiles reference. Only the
		// display name, description, license, triggers, hint, `uses` and body are
		// editable here — `input.slug` is deliberately ignored.
		const skill: ParsedSkill = { frontmatter: frontmatterFor(row.slug, input), body: input.body };
		assertValid(skill, row.slug);
		await writeSkillMd(row.slug, serializeSkillMd(skill));
		skillQueries.updateMeta(id, {
			name: input.name.trim(),
			description: input.description.trim(),
			license: input.license?.trim() || null,
			triggers: stringifyTriggers(input.triggers),
			argumentHint: input.argumentHint?.trim() || null,
			uses: stringifyUses(input.uses)
		});
		debug.log('skills', `🔧 Updated skill: ${row.slug}`);
		return toDTO(skillQueries.getById(id)!, true);
	},

	/**
	 * Parse pasted/uploaded SKILL.md text into a reviewable preview. Nothing is
	 * persisted — the UI shows the result, then calls `import` to commit it.
	 *
	 * A pasted document with no `name` but an `argument-hint` is almost certainly
	 * a pre-merge Clopen/Claude command file, so it previews as a slash skill.
	 */
	parsePreview(raw: string): ParsedSkillPreview {
		const parsed = parseSkillMd(raw);
		const warnings: string[] = [];
		const triggers = parsed.frontmatter.triggers
			? triggersFromFrontmatter(parsed.frontmatter.triggers)
			: parsed.frontmatter.argumentHint
				? (['slash'] as SkillTrigger[])
				: (['auto'] as SkillTrigger[]);
		const result = validateFrontmatter(parsed.frontmatter, undefined);
		if (!result.valid) warnings.push(...result.errors);
		return {
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			license: parsed.frontmatter.license ?? null,
			triggers,
			argumentHint: parsed.frontmatter.argumentHint ?? null,
			uses: usesFromFrontmatter(parsed.frontmatter.uses),
			body: parsed.body,
			warnings
		};
	},

	/**
	 * Persist a skill from pasted/uploaded SKILL.md text. Accepts both a real
	 * SKILL.md and a bare command document (frontmatter with only
	 * `description`/`argument-hint`, no `name`) — the latter is what users paste
	 * from a `.claude/commands/*.md`.
	 */
	async import(raw: string, nameHint?: string): Promise<SkillDTO> {
		const preview = this.parsePreview(raw);
		const parsed = parseSkillMd(raw);
		const displayName = (nameHint?.trim() || preview.name || preview.description || 'Imported skill').trim();
		const slug = nextSlug(preview.name || displayName);
		// Re-key the frontmatter `name` to the de-duped slug so it matches the folder.
		parsed.frontmatter.name = slug;
		parsed.frontmatter.triggers = stringifyTriggers(preview.triggers);
		if (!parsed.frontmatter.description.trim()) {
			// The spec requires a description and the "/" picker shows it; fall back
			// to the display name rather than rejecting a valid command paste.
			parsed.frontmatter.description = displayName;
		}
		assertValid(parsed, slug);
		await writeSkillMd(slug, serializeSkillMd(parsed));
		const row = skillQueries.insert({
			slug,
			name: displayName,
			description: parsed.frontmatter.description,
			source: 'imported',
			license: parsed.frontmatter.license ?? null,
			triggers: stringifyTriggers(preview.triggers),
			argumentHint: preview.argumentHint,
			uses: stringifyUses(preview.uses)
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
		const slug = nextSlug(parsed.frontmatter.name || displayName);
		parsed.frontmatter.name = slug;
		const triggers = triggersFromFrontmatter(parsed.frontmatter.triggers);
		parsed.frontmatter.triggers = stringifyTriggers(triggers);
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
			license: parsed.frontmatter.license ?? null,
			triggers: stringifyTriggers(triggers),
			argumentHint: parsed.frontmatter.argumentHint ?? null,
			uses: stringifyUses(usesFromFrontmatter(parsed.frontmatter.uses))
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
