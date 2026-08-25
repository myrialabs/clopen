/**
 * Pi Provider Presets Handler
 *
 * Exposes the Pi provider catalog (id, name, supported auth modes) to the
 * frontend so the login picker can render the right flow per provider without
 * importing backend modules directly. Built dynamically from `ModelRuntime`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { getPiProviderPresets } from '../../../engine/adapters/pi/presets';

export const piPresetsHandler = createRouter()
	.http('engine:pi-presets-list', {
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
					role: t.Union([t.Literal('key'), t.Literal('env')]),
					placeholder: t.Optional(t.String()),
				}))),
				oauthLabel: t.Optional(t.String()),
				apiKeyUrl: t.Optional(t.String()),
			})),
		})
	}, async () => {
		return { presets: await getPiProviderPresets() };
	});
