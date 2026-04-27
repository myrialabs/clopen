/**
 * db-client WebSocket router.
 */

import { createRouter } from '$shared/utils/ws-server';
import { connectionsHandler } from './connections';
import { schemaHandler } from './schema';
import { queryHandler } from './query';
import { structureHandler } from './structure';
import { ioHandler } from './io';

export const dbClientRouter = createRouter()
	.merge(connectionsHandler)
	.merge(schemaHandler)
	.merge(queryHandler)
	.merge(structureHandler)
	.merge(ioHandler);
