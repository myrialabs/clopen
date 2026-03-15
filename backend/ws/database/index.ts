/**
 * Database Manager WS Router
 */

import { createRouter } from '$shared/utils/ws-server';
import { connectionsHandler } from './connections';
import { queryHandler } from './query';
import { schemaHandler } from './schema';
import { historyHandler } from './history';
import { erdHandler } from './erd';
import { rbacHandler } from './rbac';
import { exportHandler } from './export';
import { backupHandler } from './backup';
import { processManagerHandler } from './process-manager';
import { datagenHandler } from './data-generator';
import { diffHandler } from './diff';
import { snippetsHandler } from './snippets';
import { sqlRestApiHandler } from './sql-rest-api';
import { healthHandler } from './health';
import { aiAssistantHandler } from './ai-assistant';
import { schemaVersioningHandler } from './schema-versioning';

export const databaseRouter = createRouter()
	.merge(connectionsHandler)
	.merge(queryHandler)
	.merge(schemaHandler)
	.merge(historyHandler)
	.merge(erdHandler)
	.merge(rbacHandler)
	.merge(exportHandler)
	.merge(backupHandler)
	.merge(processManagerHandler)
	.merge(datagenHandler)
	.merge(diffHandler)
	.merge(snippetsHandler)
	.merge(sqlRestApiHandler)
	.merge(healthHandler)
	.merge(aiAssistantHandler)
	.merge(schemaVersioningHandler);
