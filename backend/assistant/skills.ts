/**
 * Skills the assistant writes and improves.
 *
 * A skill is procedural memory: after a task that took real work, or when the
 * owner keeps asking for the same thing, the assistant saves how it is done.
 * When a skill needed correcting while it ran, the assistant improves it. Every
 * change is a revision (see `skill_versions`) the owner can compare and revert,
 * so an improvement that made things worse is one click from undone.
 */

import { parseTriggers, skillQueries, skillVersionQueries } from '$backend/database/queries';
import { skillService, type SkillDTO } from '$backend/skills';
import { parseSkillMd } from '$backend/skills/spec';
import { readSkillMd } from '$backend/skills/store';
import type { SkillVersion } from '$shared/types/assistant';
import { notifyAssistantChanged } from './events';

export async function saveSkillContent(input: {
	slug?: string;
	name: string;
	description: string;
	body: string;
	argumentHint?: string | null;
	slashCommand?: boolean;
	createdBy: 'user' | 'assistant';
	note: string;
}): Promise<SkillDTO> {
	const existing = input.slug ? skillQueries.getBySlug(input.slug) : null;
	const triggers: Array<'auto' | 'slash'> = input.slashCommand === false ? ['auto'] : ['auto', 'slash'];
	const fields = {
		slug: input.slug,
		name: input.name,
		description: input.description,
		body: input.body,
		triggers,
		argumentHint: input.argumentHint ?? null
	};
	const meta = { note: input.note, createdBy: input.createdBy };
	const skill = existing ? await skillService.update(existing.id, fields, meta) : await skillService.create(fields, meta);
	notifyAssistantChanged('skills', skill.slug);
	return skill;
}

export function skillVersions(slug: string): SkillVersion[] {
	return skillVersionQueries.list(slug).map((row) => ({
		id: row.id,
		skillSlug: row.skill_slug,
		version: row.version,
		content: row.content,
		note: row.note,
		createdBy: row.created_by,
		createdAt: row.created_at
	}));
}

/** Put a skill back to an earlier revision — recorded as a new revision, so the revert is itself undoable. */
export async function revertSkill(slug: string, version: number): Promise<SkillDTO> {
	const row = skillQueries.getBySlug(slug);
	if (!row) throw new Error(`There is no skill "${slug}".`);
	const target = skillVersionQueries.get(slug, version);
	if (!target) throw new Error(`Skill "${slug}" has no version ${version}.`);
	const parsed = parseSkillMd(target.content);
	return skillService.update(
		row.id,
		{
			name: parsed.frontmatter.name ?? row.name,
			description: parsed.frontmatter.description ?? row.description,
			body: parsed.body,
			triggers: parseTriggers(row.triggers),
			argumentHint: row.argument_hint
		},
		{ note: `Reverted to version ${version}`, createdBy: 'user' }
	);
}

export async function readSkill(slug: string): Promise<{ skill: SkillDTO; body: string } | null> {
	const row = skillQueries.getBySlug(slug);
	if (!row) return null;
	const raw = await readSkillMd(row.slug);
	if (raw && !skillVersionQueries.latest(slug)) {
		// A skill made before revisions existed gets its current text as version 1.
		skillVersionQueries.add(slug, raw, 'Existing version', 'user');
	}
	return skillService.get(row.id);
}
