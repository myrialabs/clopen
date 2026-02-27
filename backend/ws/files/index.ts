/**
 * Files Router
 *
 * Combines all file WebSocket handlers into a single router.
 *
 * Structure:
 * - read.ts: HTTP endpoints for reading (list-tree, browse, read-file, read-content)
 * - write.ts: HTTP endpoints for writing (write, create, rename, duplicate, upload, delete)
 * - search.ts: HTTP endpoints for searching (search-files, search-code)
 * - watch.ts: Event handlers for real-time file watching
 */

import { createRouter } from '$shared/utils/ws-server';
import { readHandler } from './read';
import { writeHandler } from './write';
import { fileSearchHandler } from './search';
import { watchHandler } from './watch';

export const filesRouter = createRouter()
	// Read Operations (HTTP)
	.merge(readHandler)

	// Write Operations (HTTP)
	.merge(writeHandler)

	// Search Operations (HTTP)
	.merge(fileSearchHandler)

	// Watch Operations (Events)
	.merge(watchHandler);
