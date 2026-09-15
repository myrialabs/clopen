/**
 * db-client WebSocket router.
 *
 * Importing `$backend/db-client/integrations` is what registers the `database`
 * projector and the Supabase provider, so merging this router into the app is
 * also what makes account-backed connections exist. Same arrangement as the
 * Deployments router, and for the same reason: a surface with no routes has no
 * providers to register either.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import '../../db-client/integrations';
import { connectionsHandler } from './connections';
import { schemaHandler } from './schema';
import { queryHandler } from './query';
import { structureHandler } from './structure';
import { ioHandler } from './io';
import { accountsHandler } from './accounts';
import { supabaseHandler } from './supabase';
import { envHandler } from './env';

export const dbClientRouter = createRouter()
	.merge(connectionsHandler)
	.merge(schemaHandler)
	.merge(queryHandler)
	.merge(structureHandler)
	.merge(ioHandler)
	.merge(accountsHandler)
	.merge(supabaseHandler)
	.merge(envHandler)
	/**
	 * Broadcast when the connection list changes for a reason the requesting
	 * client did not cause — a link created, a link dropped, an account
	 * disconnected. A projected connection is visible to every admin, so a
	 * client that only refreshed after its own requests would show a stale list.
	 */
	.emit('db-client:connections-changed', t.Object({}));
