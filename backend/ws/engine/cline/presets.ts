/**
 * Cline Provider Presets Handler
 *
 * Exposes the Cline provider catalog (id, name, supported auth modes, credential
 * fields) to the frontend so the login picker can render the right flow per
 * provider without importing backend modules directly. Built from the `@cline/llms`
 * catalog + `getProviderConfigFields`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { getClineProviderPresets } from '../../../engine/adapters/cline/presets';

export const clinePresetsHandler = createRouter()
	.http('engine:cline-presets-list', {
		data: t.Object({}),
		response: t.Object({
			presets: t.Array(t.Object({
				id: t.String(),
				name: t.String(),
				authModes: t.Array(t.Union([t.Literal('api_key'), t.Literal('oauth')])),
				fields: t.Optional(t.Array(t.Object({
					key: t.String(),
					label: t.String(),
					secret: t.Boolean(),
					role: t.Union([t.Literal('apiKey'), t.Literal('baseUrl'), t.Literal('field')]),
					placeholder: t.Optional(t.String()),
					optional: t.Optional(t.Boolean()),
				}))),
				oauthLabel: t.Optional(t.String()),
				apiKeyUrl: t.Optional(t.String()),
			})),
		})
	}, async () => {
		return { presets: await getClineProviderPresets() };
	});
