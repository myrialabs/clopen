/**
 * Integrations Router
 *
 * Connect, reconfigure and disconnect third-party accounts. What an integration
 * DOES is not here — that lives in the surface that owns the work.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { integrationsCrudHandler } from './crud';

export const integrationsRouter = createRouter()
	.merge(integrationsCrudHandler)
	/**
	 * Broadcast after any account mutation. The hub also shows connectors, whose
	 * rows a projection creates and removes, so a client that only watched its
	 * own request would miss a connector appearing because someone else
	 * connected an account.
	 */
	.emit('integrations:changed', t.Object({
		accountId: t.Optional(t.String())
	}));
