/**
 * Skill Marketplace Handlers
 *
 *   - skills:catalog  — browse the skill catalog (paginated, searchable)
 *   - skills:install  — install a skill from the catalog into the canonical store
 *
 * Skills come from the community registry. See backend/skills/marketplace.ts.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { listMarketplaceSkills, skillService } from '$backend/skills';

const MARKETPLACE_SKILL_SCHEMA = t.Object({
	ref: t.String(),
	name: t.String(),
	slug: t.String(),
	description: t.String(),
	stars: t.Optional(t.Number()),
	verified: t.Optional(t.Boolean()),
	homepage: t.Optional(t.String())
});

const SKILL_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	source: t.Union([t.Literal('custom'), t.Literal('imported'), t.Literal('marketplace')]),
	marketplaceRef: t.Union([t.String(), t.Null()]),
	version: t.Union([t.String(), t.Null()]),
	license: t.Union([t.String(), t.Null()]),
	enabled: t.Boolean(),
	present: t.Boolean(),
	createdAt: t.String()
});

export const skillCatalogHandler = createRouter()
	.http('skills:catalog', {
		data: t.Object({
			search: t.Optional(t.String()),
			cursor: t.Optional(t.String())
		}),
		response: t.Object({
			skills: t.Array(MARKETPLACE_SKILL_SCHEMA),
			nextCursor: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		debug.log('path', `skills:catalog q="${data.search ?? ''}"`);
		return listMarketplaceSkills(data.search ?? '', data.cursor ?? null);
	})
	.http('skills:marketplace-detail', {
		data: t.Object({ ref: t.String() }),
		response: t.Object({
			name: t.String(),
			description: t.String(),
			license: t.Union([t.String(), t.Null()]),
			body: t.String()
		})
	}, async ({ data }) => {
		debug.log('path', `skills:marketplace-detail ${data.ref}`);
		return skillService.previewInstall(data.ref);
	})
	.http('skills:install', {
		data: t.Object({
			ref: t.String(),
			name: t.Optional(t.String()),
			description: t.Optional(t.String()),
			license: t.Optional(t.Union([t.String(), t.Null()])),
			body: t.Optional(t.String())
		}),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:install ${data.ref}`);
		const { ref, ...override } = data;
		const skill = await skillService.install(ref, override);
		return { skill };
	});
