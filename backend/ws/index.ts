/**
 * WebSocket Main Router
 *
 * This is the main entry point for all WebSocket routes.
 * All module routers are imported from their respective folders and merged here.
 *
 * Structure follows backend/routes pattern:
 * - Each feature group has its own folder (demo/, chat/, terminal/, etc.)
 * - Each folder contains handlers and an index.ts that exports the router
 * - This file imports and merges all routers into a single API type
 */

import { createRouter } from '$shared/utils/ws-server';

// Import all module routers
import { chatRouter } from './chat';
import { terminalRouter } from './terminal';
import { previewRouter } from './preview';
import { snapshotRouter } from './snapshot';
import { projectsRouter } from './projects';
import { sessionsRouter } from './sessions';
import { messagesRouter } from './messages';
import { settingsRouter } from './settings';
import { userRouter } from './user';
import { filesRouter } from './files';
import { systemRouter } from './system';
import { tunnelRouter } from './tunnel';
import { gitRouter } from './git';
import { mcpRouter } from './mcp';
import { engineRouter } from './engine';

// ============================================
// Main App Router - Merge All Module Routers
// ============================================

export const wsRouter = createRouter()
	// Terminal System
	.merge(terminalRouter)

	// Preview
	.merge(previewRouter)

	// Chat System
	.merge(chatRouter)

	// Snapshot System
	.merge(snapshotRouter)

	// CRUD Operations
	.merge(projectsRouter)
	.merge(sessionsRouter)
	.merge(messagesRouter)
	.merge(settingsRouter)
	.merge(userRouter)
	.merge(filesRouter)
	.merge(systemRouter)
	.merge(tunnelRouter)

	// Git Source Control
	.merge(gitRouter)

	// MCP (bridge for Open Code stdio server)
	.merge(mcpRouter)

	// AI Engine Management
	.merge(engineRouter);

// Export API type for frontend type-safe access
export type WSAPI = typeof wsRouter['$api'];
