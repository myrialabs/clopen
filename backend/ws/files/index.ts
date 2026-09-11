/**
 * Files Router
 *
 * Combines all file WebSocket handlers into a single router.
 *
 * Structure:
 * - read.ts: HTTP endpoints for reading (list-tree, browse, read-file, read-content)
 * - write.ts: HTTP endpoints for writing (write, create, rename, duplicate, upload, delete)
 * - reveal.ts: HTTP endpoint for revealing files in the OS file manager
 * - clipboard.ts: HTTP endpoints for the native OS clipboard bridge (admin-only)
 * - search.ts: HTTP endpoints for searching (search-files, search-code)
 * - watch.ts: Event handlers for real-time file watching
 */

import { createRouter } from '$shared/utils/ws-server';
import { readHandler } from './read';
import { writeHandler } from './write';
import { revealHandler } from './reveal';
import { clipboardHandler } from './clipboard';
import { imageEditHandler } from './image-edit';
import { fileSearchHandler } from './search';
import { watchHandler } from './watch';
import { filesStateHandler } from './state';

export const filesRouter = createRouter()
	// Read Operations (HTTP)
	.merge(readHandler)

	// Write Operations (HTTP)
	.merge(writeHandler)

	// Reveal in File Manager (HTTP)
	.merge(revealHandler)

	// OS Clipboard bridge — read/write native file-drop lists (HTTP)
	.merge(clipboardHandler)

	// Image Edit Operation (HTTP)
	.merge(imageEditHandler)

	// Search Operations (HTTP)
	.merge(fileSearchHandler)

	// Watch Operations (Events)
	.merge(watchHandler)

	// Panel state (HTTP)
	.merge(filesStateHandler);
