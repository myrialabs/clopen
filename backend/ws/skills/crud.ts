/**
 * Skill CRUD Handlers
 *
 * Manage user Agent Skills (Settings → Skills) — one feature covering both
 * model-invoked skills (`auto`) and user-invoked `/slash` prompts:
 *   - skills:list         — installed skills (DB metadata + on-disk presence)
 *   - skills:get          — one skill plus its SKILL.md body (for the editor)
 *   - skills:create       — author a skill from editor fields
 *   - skills:update       — edit an existing skill
 *   - skills:parse-import — preview a pasted/uploaded SKILL.md before importing
 *   - skills:import       — persist a pasted/uploaded SKILL.md
 *   - skills:toggle       — enable / disable
 *   - skills:delete       — remove
 *   - skills:detect       — on-disk skills (managed + adoptable) per engine
 *   - skills:adopt        — link an adoptable on-disk skill into Clopen's engine dir
 *   - skills:available    — slash-invocable skills for the chat "/" picker
 *
 * Mutations are admin-gated (see backend/auth/permissions.ts) — except
 * `skills:available`, which any user needs in order to type a command. Changes
 * take effect on the next chat stream, when each engine re-syncs its skills.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { skillService, detectSkills, syncSkillsAllEngines } from '$backend/skills';
import { adoptArtifact, ARTIFACT_ENGINES, type ArtifactEngine } from '$backend/artifacts';
import { resolveActiveProfileId, artifactFilter } from '$backend/profiles';
import type { SkillTrigger } from '$backend/database/queries';

const SOURCE_SCHEMA = t.Union([t.Literal('custom'), t.Literal('imported'), t.Literal('marketplace')]);
const TRIGGER_SCHEMA = t.Union([t.Literal('auto'), t.Literal('slash')]);

const SKILL_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	source: SOURCE_SCHEMA,
	marketplaceRef: t.Union([t.String(), t.Null()]),
	version: t.Union([t.String(), t.Null()]),
	license: t.Union([t.String(), t.Null()]),
	triggers: t.Array(TRIGGER_SCHEMA),
	argumentHint: t.Union([t.String(), t.Null()]),
	uses: t.Array(t.String()),
	enabled: t.Boolean(),
	present: t.Boolean(),
	createdAt: t.String()
});

const FIELDS_SCHEMA = {
	name: t.String(),
	description: t.String(),
	body: t.String(),
	license: t.Optional(t.String()),
	triggers: t.Optional(t.Array(TRIGGER_SCHEMA)),
	argumentHint: t.Optional(t.Union([t.String(), t.Null()])),
	uses: t.Optional(t.Array(t.String()))
};

const DETECTED_SCHEMA = t.Object({
	engine: t.String(),
	detected: t.Array(t.Object({
		slug: t.String(),
		name: t.String(),
		description: t.String(),
		path: t.String(),
		managed: t.Boolean(),
		adoptable: t.Boolean()
	}))
});

/** Editor fields, with `triggers` narrowed back to the service's union type. */
function toInput(data: {
	slug?: string;
	name: string;
	description: string;
	body: string;
	license?: string;
	triggers?: string[];
	argumentHint?: string | null;
	uses?: string[];
}) {
	return {
		slug: data.slug,
		name: data.name,
		description: data.description,
		body: data.body,
		license: data.license,
		triggers: data.triggers as SkillTrigger[] | undefined,
		argumentHint: data.argumentHint,
		uses: data.uses
	};
}

export const skillCrudHandler = createRouter()
	.http('skills:list', {
		data: t.Object({}),
		response: t.Object({ skills: t.Array(SKILL_SCHEMA) })
	}, async () => {
		debug.log('path', 'skills:list');
		return { skills: await skillService.list() };
	})
	.http('skills:get', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ skill: SKILL_SCHEMA, body: t.String() })
	}, async ({ data }) => {
		debug.log('path', `skills:get ${data.id}`);
		const result = await skillService.get(data.id);
		if (!result) throw new Error('Skill not found');
		return result;
	})
	.http('skills:create', {
		// `slug` is create-only — see SkillInputFields for why it can't be renamed.
		data: t.Object({ slug: t.Optional(t.String()), ...FIELDS_SCHEMA }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:create ${data.name}`);
		if (!data.name.trim()) throw new Error('A skill name is required');
		if (!data.description.trim()) throw new Error('A skill description is required');
		if (!data.body.trim()) throw new Error('Instructions are required');
		const skill = await skillService.create(toInput(data));
		await syncSkillsAllEngines();
		return { skill };
	})
	.http('skills:update', {
		data: t.Object({ id: t.Number(), ...FIELDS_SCHEMA }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:update ${data.id}`);
		if (!data.name.trim()) throw new Error('A skill name is required');
		if (!data.description.trim()) throw new Error('A skill description is required');
		if (!data.body.trim()) throw new Error('Instructions are required');
		const skill = await skillService.update(data.id, toInput(data));
		await syncSkillsAllEngines();
		return { skill };
	})
	.http('skills:parse-import', {
		// Preview a pasted/uploaded SKILL.md. Pure transform — nothing persisted.
		data: t.Object({ text: t.String() }),
		response: t.Object({
			name: t.String(),
			description: t.String(),
			license: t.Union([t.String(), t.Null()]),
			triggers: t.Array(TRIGGER_SCHEMA),
			argumentHint: t.Union([t.String(), t.Null()]),
			uses: t.Array(t.String()),
			body: t.String(),
			warnings: t.Array(t.String())
		})
	}, async ({ data }) => {
		debug.log('path', 'skills:parse-import');
		return skillService.parsePreview(data.text);
	})
	.http('skills:import', {
		data: t.Object({ text: t.String(), name: t.Optional(t.String()) }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', 'skills:import');
		const skill = await skillService.import(data.text, data.name);
		await syncSkillsAllEngines();
		return { skill };
	})
	.http('skills:toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:toggle ${data.id} → ${data.enabled}`);
		const skill = skillService.toggle(data.id, data.enabled);
		await syncSkillsAllEngines();
		return { skill };
	})
	.http('skills:delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `skills:delete ${data.id}`);
		await skillService.remove(data.id);
		await syncSkillsAllEngines();
		return { success: true };
	})
	.http('skills:detect', {
		data: t.Object({ projectPath: t.Optional(t.String()) }),
		response: t.Object({ groups: t.Array(DETECTED_SCHEMA) })
	}, async ({ data }) => {
		debug.log('path', 'skills:detect');
		return { groups: await detectSkills(data.projectPath) };
	})
	.http('skills:adopt', {
		// Link a skill the user already has on disk into Clopen's isolated engine
		// dir, so it takes effect without relocating their file. `adoptArtifact`
		// existed since the framework landed but had no caller — "detect" could
		// only ever report, never act.
		data: t.Object({ engine: t.String(), slug: t.String(), path: t.String() }),
		response: t.Object({ linkedTo: t.String() })
	}, async ({ data }) => {
		debug.log('path', `skills:adopt ${data.engine}/${data.slug}`);
		if (!ARTIFACT_ENGINES.includes(data.engine as ArtifactEngine)) {
			throw new Error(`Unknown engine "${data.engine}"`);
		}
		const linkedTo = await adoptArtifact(
			'skill',
			{ engine: data.engine as ArtifactEngine, scope: 'global' },
			data.path,
			data.slug
		);
		return { linkedTo };
	})
	.http('skills:available', {
		// Non-admin: slash-invocable skills for the chat "/" picker (display fields
		// only), narrowed by the session's active profile same as stream sync.
		data: t.Object({
			profileId: t.Optional(t.Union([t.Number(), t.Null()])),
			projectId: t.Optional(t.String())
		}),
		response: t.Object({
			skills: t.Array(t.Object({
				slug: t.String(),
				name: t.String(),
				description: t.String(),
				argumentHint: t.Union([t.String(), t.Null()])
			}))
		})
	}, async ({ data }) => {
		debug.log('path', 'skills:available');
		const activeProfileId = resolveActiveProfileId(data.profileId ?? null, data.projectId);
		const filter = artifactFilter(activeProfileId, 'skill');
		return { skills: skillService.available(filter) };
	});
