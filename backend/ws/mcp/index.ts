/**
 * MCP Router
 *
 * Entry point for external (user-installed) MCP server management:
 *   - mcp:catalog                   — browse the official MCP registry
 *   - mcp:list / install / toggle / uninstall — manage installed servers
 *
 * Internal custom-tool servers (backend/mcp/internal) are NOT managed here —
 * they are defined in code.
 */

import { createRouter } from '$shared/utils/ws-server';
import { mcpCatalogHandler } from './catalog';
import { mcpCrudHandler } from './crud';

export const mcpRouter = createRouter()
	.merge(mcpCatalogHandler)
	.merge(mcpCrudHandler);
