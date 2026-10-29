/**
 * Remote Access share handler.
 *
 * `share:ensure-origin` returns a public origin that Remote Access share links
 * are built against, transparently starting a Cloudflare quick tunnel to
 * Clopen's own port only when the app isn't already reachable on a real domain.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { resolvePublicOrigin } from '../../tunnel/public-origin';

export const shareHandler = createRouter()
	.http('share:ensure-origin', {
		data: t.Object({
			/** The client's own window.location.origin — used to detect an already-public deployment. */
			requestOrigin: t.Optional(t.String())
		}),
		response: t.Object({
			origin: t.String(),
			source: t.Union([t.Literal('configured'), t.Literal('domain'), t.Literal('tunnel')])
		})
	}, async ({ data }) => {
		return resolvePublicOrigin(data.requestOrigin);
	});
