#!/usr/bin/env bun
/**
 * MCP Stdio Server for Open Code
 *
 * Standalone subprocess that exposes our custom MCP tools via stdio transport.
 * Open Code spawns this process and communicates over stdin/stdout (JSON-RPC 2.0).
 *
 * Tool definitions (schema, description) are loaded from the SAME source as
 * Claude Code — the `serverMetadata` registry in `./servers/index.ts`.
 *
 * ALL tool calls are proxied to the main Clopen server via WSClient bridge,
 * because handlers need in-process access to browser instances, project context, etc.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WSClient } from '$shared/utils/ws-client';
import { serverMetadata } from './servers/index';
import { mcpServers } from './config';

// ============================================================================
// WebSocket Bridge — proxies tool calls to the main Clopen server via WSClient
// ============================================================================

const BRIDGE_PORT = process.env.CLOPEN_PORT || '9141';
const WS_URL = `ws://localhost:${BRIDGE_PORT}/ws`;

/**
 * WSClient instance for communicating with the main Clopen server.
 * Uses the same protocol as the frontend (JSON messages with action/payload).
 */
const wsClient = new WSClient<any>(WS_URL, {
	autoReconnect: true,
	maxReconnectAttempts: 10,
	reconnectDelay: 1000,
	maxReconnectDelay: 10000,
});

/**
 * Call a tool handler on the main Clopen server via the WS bridge.
 * Uses WSClient.http() which follows the standard request-response pattern.
 */
async function callBridge(
	serverName: string,
	toolName: string,
	args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
	try {
		return await wsClient.http('mcp:execute' as any, {
			server: serverName,
			tool: toolName,
			args,
		} as any, 30000);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: 'text', text: `Bridge connection failed: ${msg}` }],
			isError: true,
		};
	}
}

// ============================================================================
// Build MCP server from existing server metadata (single source of truth)
// ============================================================================

const server = new McpServer({
	name: 'clopen-mcp',
	version: '1.0.0',
});

// Iterate over all configured servers and register their enabled tools
for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
	if (!serverConfig.enabled) continue;

	// Get tool definitions from the metadata registry
	const meta = (serverMetadata as Record<string, { toolDefs: Record<string, { description: string; schema: Record<string, any> }> }>)[serverName];
	if (!meta) continue;

	for (const toolName of serverConfig.tools) {
		const toolDef = meta.toolDefs[toolName];
		if (!toolDef) continue;

		// Register tool with the same schema/description, but handler goes through bridge
		server.registerTool(
			toolName,
			{
				description: toolDef.description,
				inputSchema: toolDef.schema,
			},
			async (args: Record<string, unknown>) => {
				return await callBridge(serverName, toolName, args) as any;
			}
		);
	}
}

// ============================================================================
// Connect via stdio transport
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
