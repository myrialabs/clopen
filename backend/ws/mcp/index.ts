/**
 * MCP Router
 *
 * Entry point for external (user-installed) MCP server management:
 *   - mcp:catalog                   — browse the official MCP registry
 *   - mcp:list / install / toggle / uninstall — manage installed servers
 *   - mcp:tools / set-tool-overrides / call-tool — per-tool control + inspector
 *
 * Internal custom-tool servers (backend/mcp/internal) are NOT managed here —
 * they are defined in code.
 */

import { createRouter } from '$shared/utils/ws-server';
import { mcpCatalogHandler } from './catalog';
import { mcpCrudHandler } from './crud';
import { mcpToolsHandler } from './tools';

export const mcpRouter = createRouter()
	.merge(mcpCatalogHandler)
	.merge(mcpCrudHandler)
	.merge(mcpToolsHandler);
