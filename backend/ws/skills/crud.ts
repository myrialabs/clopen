/**
 * Skill CRUD Handlers
 *
 * Manage user Agent Skills (Settings → Skills):
 *   - skills:list         — installed skills (DB metadata + on-disk presence)
 *   - skills:get          — one skill plus its SKILL.md body (for the editor)
 *   - skills:create       — author a skill from editor fields
 *   - skills:update       — edit an existing skill
 *   - skills:parse-import — preview a pasted/uploaded SKILL.md before importing
 *   - skills:import       — persist a pasted/uploaded SKILL.md
 *   - skills:toggle       — enable / disable
 *   - skills:delete       — remove
 *
 * Mutations are admin-gated (see backend/auth/permissions.ts). Changes take
 * effect on the next chat stream, when each engine re-syncs its skills.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { skillService } from '$backend/skills';

const SOURCE_SCHEMA = t.Union([t.Literal('custom'), t.Literal('imported'), t.Literal('marketplace')]);

const SKILL_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	source: SOURCE_SCHEMA,
	marketplaceRef: t.Union([t.String(), t.Null()]),
	version: t.Union([t.String(), t.Null()]),
	license: t.Union([t.String(), t.Null()]),
	enabled: t.Boolean(),
	present: t.Boolean(),
	createdAt: t.String()
});

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
		data: t.Object({
			name: t.String(),
			description: t.String(),
			body: t.String(),
			license: t.Optional(t.String())
		}),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:create ${data.name}`);
		if (!data.name.trim()) throw new Error('A skill name is required');
		if (!data.description.trim()) throw new Error('A skill description is required');
		const skill = await skillService.create(data);
		return { skill };
	})
	.http('skills:update', {
		data: t.Object({
			id: t.Number(),
			name: t.String(),
			description: t.String(),
			body: t.String(),
			license: t.Optional(t.String())
		}),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:update ${data.id}`);
		if (!data.name.trim()) throw new Error('A skill name is required');
		if (!data.description.trim()) throw new Error('A skill description is required');
		const skill = await skillService.update(data.id, data);
		return { skill };
	})
	.http('skills:parse-import', {
		// Preview a pasted/uploaded SKILL.md. Pure transform — nothing persisted.
		data: t.Object({ text: t.String() }),
		response: t.Object({
			name: t.String(),
			description: t.String(),
			license: t.Union([t.String(), t.Null()]),
			body: t.String(),
			warnings: t.Array(t.String())
		})
	}, async ({ data }) => {
		debug.log('path', 'skills:parse-import');
		return skillService.parsePreview(data.text);
	})
	.http('skills:import', {
		data: t.Object({ text: t.String() }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', 'skills:import');
		const skill = await skillService.import(data.text);
		return { skill };
	})
	.http('skills:toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:toggle ${data.id} → ${data.enabled}`);
		return { skill: skillService.toggle(data.id, data.enabled) };
	})
	.http('skills:delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `skills:delete ${data.id}`);
		await skillService.remove(data.id);
		return { success: true };
	});
