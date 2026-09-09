/**
 * `POST /api/integrations/hooks/<provider>` — the only unauthenticated route
 * Clopen exposes on purpose.
 *
 * `parse: 'none'` is load-bearing. Elysia would otherwise parse the body for us
 * and the handler would only ever see a re-serialised copy, whose bytes are not
 * the bytes the provider signed. Reading `request.arrayBuffer()` ourselves is
 * the only way to verify a signature honestly.
 *
 * The policy — deny by default, uniform 404s, size cap before parsing, replay
 * rejection, rate limit — lives in `backend/integrations/webhooks/gateway.ts`.
 * This file is the transport.
 */

import { Elysia } from 'elysia';

import { handleInboundDelivery, MAX_BODY_BYTES } from '$backend/integrations';
import { debug } from '$shared/utils/logger';

export const integrationHooksRoute = new Elysia()
	.post('/api/integrations/hooks/:provider', async ({ params, request }) => {
		// Cap on the declared length first — cheap, and it rejects the obvious
		// case before a single byte is read.
		const declared = Number(request.headers.get('content-length') ?? '0');
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			debug.warn('integrations', `Rejected oversized ${params.provider} delivery (${declared} bytes)`);
			return new Response('Not found', { status: 404 });
		}

		const raw = new Uint8Array(await request.arrayBuffer());

		// And again on what actually arrived: `content-length` is a claim, and a
		// chunked request does not carry one at all.
		if (raw.byteLength > MAX_BODY_BYTES) {
			debug.warn('integrations', `Rejected oversized ${params.provider} delivery (${raw.byteLength} bytes)`);
			return new Response('Not found', { status: 404 });
		}

		return handleInboundDelivery(params.provider, raw, request.headers);
	}, {
		parse: 'none'
	});
