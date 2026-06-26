/**
 * Skill Marketplace Handlers
 *
 *   - skills:catalog  — browse a provider's skill catalog (paginated, searchable)
 *   - skills:install  — install a skill from a provider into the canonical store
 *
 * Two providers ship: `official` (Anthropic's curated repo, default) and
 * `community` (a broader third-party registry). See backend/skills/marketplace.ts.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { listMarketplaceSkills, skillService } from '$backend/skills';

const PROVIDER_SCHEMA = t.Union([t.Literal('official'), t.Literal('community')]);

const MARKETPLACE_SKILL_SCHEMA = t.Object({
	ref: t.String(),
	provider: PROVIDER_SCHEMA,
	name: t.String(),
	slug: t.String(),
	description: t.String(),
	stars: t.Optional(t.Number()),
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
			provider: t.Optional(PROVIDER_SCHEMA),
			search: t.Optional(t.String()),
			cursor: t.Optional(t.String())
		}),
		response: t.Object({
			skills: t.Array(MARKETPLACE_SKILL_SCHEMA),
			nextCursor: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		debug.log('path', `skills:catalog ${data.provider ?? 'official'}`);
		return listMarketplaceSkills(data.provider ?? 'official', data.search ?? '', data.cursor ?? null);
	})
	.http('skills:install', {
		data: t.Object({ ref: t.String() }),
		response: t.Object({ skill: SKILL_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `skills:install ${data.ref}`);
		const skill = await skillService.install(data.ref);
		return { skill };
	});
