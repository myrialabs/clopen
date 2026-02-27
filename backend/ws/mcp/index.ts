/**
 * MCP Bridge — WebSocket HTTP-like route for the stdio MCP server
 *
 * Provides a WS route that the MCP stdio server (spawned by Open Code)
 * uses to execute tool handlers in-process.
 *
 * Handlers are loaded from the SAME serverMetadata registry —
 * no duplication of tool names or handler imports.
 *
 * Route: mcp:execute (WS http-like request-response)
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { debug } from '$shared/utils/logger';
import { serverMetadata } from '../../lib/mcp/servers/index';
import { mcpServers } from '../../lib/mcp/config';

export const mcpRouter = createRouter()
	.http('mcp:execute', {
		data: t.Object({
			server: t.String(),
			tool: t.String(),
			args: t.Record(t.String(), t.Unknown()),
		}),
		response: t.Any(),
	}, async ({ data }) => {
		const { server, tool, args } = data;

		debug.log('mcp', `🌉 Bridge: ${server}/${tool}`);

		// Validate server exists and is enabled
		const serverConfig = mcpServers[server];
		if (!serverConfig?.enabled) {
			return {
				content: [{ type: 'text', text: `Unknown or disabled MCP server: ${server}` }],
				isError: true,
			};
		}

		// Get handler from the single-source metadata registry
		const meta = (serverMetadata as Record<string, { toolDefs: Record<string, { handler: (args: any) => Promise<any> }> }>)[server];
		const toolDef = meta?.toolDefs[tool];
		if (!toolDef) {
			return {
				content: [{ type: 'text', text: `Unknown tool: ${tool} in server ${server}` }],
				isError: true,
			};
		}

		try {
			return await toolDef.handler(args);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			debug.error('mcp', `🌉 Bridge error: ${server}/${tool}: ${errorMessage}`);
			return {
				content: [{ type: 'text', text: `Tool execution error: ${errorMessage}` }],
				isError: true,
			};
		}
	});
