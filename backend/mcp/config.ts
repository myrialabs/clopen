/**
 * MCP Custom Tools Configuration & Registry
 *
 * This file combines server registry and configuration in one place
 * to avoid duplication and make it easier to add new servers.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpRemoteConfig } from '@opencode-ai/sdk';
import type { ServerConfig, ParsedMcpToolName, ServerName } from './types';
import type { McpExecutionContext } from '../engine/types';
import { serverRegistry, serverFactories, serverMetadata } from './servers';
import { projectContextService } from './project-context';
import { debug } from '$shared/utils/logger';
import { SERVER_ENV } from '../utils/env';

/**
 * User-defined MCP Servers Configuration
 *
 * Define your server configuration here. Only specify `enabled` and `tools`.
 * Server instances are automatically merged from the registry.
 *
 * Type-safe: Server names and tool names are validated at compile time!
 */
export const mcpServersConfig: Record<ServerName, ServerConfig> = {
	"weather-service": {
		enabled: true,
		tools: [
			"get_temperature",
		]
	},
	"browser-automation": {
		enabled: true,
		tools: [
			// Tab Management
			"list_tabs",
			"switch_tab",
			"open_new_tab",
			"close_tab",

			// Navigation
			"navigate",

			// Browser Actions
			"actions",

			// Page Inspection
			"analyze_dom",
			"take_screenshot",
			"get_console_logs",
			"clear_console_logs",
			"execute_console",
		]
	}
};

/**
 * Helper to merge user config with server instances from registry
 */
function createServerConfig<T extends Record<ServerName, ServerConfig>>(
	config: T
): { [K in keyof T]: T[K] & { instance: McpSdkServerConfigWithInstance } } {
	const result = {} as any;

	for (const [serverName, serverConfig] of Object.entries(config)) {
		result[serverName] = {
			...serverConfig,
			instance: serverRegistry[serverName as ServerName]
		};
	}

	return result;
}

/**
 * MCP Servers Configuration with instances
 *
 * This is the final configuration used throughout the application.
 * Automatically merges user config with server instances.
 */
export const mcpServers: Record<string, ServerConfig & { instance: McpSdkServerConfigWithInstance }> = createServerConfig(mcpServersConfig);

// ============================================================================
// Server Registry Functions
// ============================================================================

/**
 * Get all enabled MCP servers for Claude SDK.
 *
 * Creates FRESH server instances each call so that concurrent streams
 * each get their own Protocol — avoids "Already connected to a transport" errors.
 *
 * When `context` is provided, tool handlers are wrapped to restore the
 * AsyncLocalStorage execution context. This is required because the SDK
 * invokes MCP tool handlers through IPC which breaks AsyncLocalStorage
 * propagation — without this, background streams from Project A would
 * resolve to Project B's preview browser when the user switches projects.
 */
export function getEnabledMcpServers(context?: McpExecutionContext): Record<string, McpServerConfig> {
	const enabledServers: Record<string, McpServerConfig> = {};

	Object.entries(mcpServers).forEach(([serverName, serverConfig]) => {
		if (serverConfig.enabled) {
			if (context) {
				// Create context-bound instance: wrap each tool handler so
				// AsyncLocalStorage context is restored on invocation
				const meta = serverMetadata[serverName as ServerName];
				const sdkTools = (serverConfig.tools as readonly string[]).map(toolName => {
					const def = meta.toolDefs[toolName];
					const boundHandler = async (args: any) => {
						return projectContextService.runWithContextAsync(context, () => def.handler(args));
					};
					return tool(toolName, def.description, def.schema, boundHandler as any);
				});
				enabledServers[serverName] = createSdkMcpServer({
					name: meta.name,
					version: '1.0.0',
					tools: sdkTools
				});
			} else {
				const factory = serverFactories[serverName as ServerName];
				enabledServers[serverName] = factory ? factory() : serverConfig.instance;
			}
			debug.log('mcp', `✓ Enabled MCP server: ${serverName}${context ? ' (context-bound)' : ''}`);
		} else {
			debug.log('mcp', `✗ Disabled MCP server: ${serverName}`);
		}
	});

	debug.log('mcp', `Total enabled MCP servers: ${Object.keys(enabledServers).length}`);

	return enabledServers;
}

/**
 * Get list of all allowed MCP tool names
 *
 * Tool names follow the format: mcp__{server-name}__{tool-name}
 * Example: "mcp__weather-service__get_temperature"
 */
export function getAllowedMcpTools(): string[] {
	const tools: string[] = [];

	Object.entries(mcpServers).forEach(([serverName, serverConfig]) => {
		if (!serverConfig.enabled) return;

		serverConfig.tools.forEach((toolName) => {
			const formattedName = `mcp__${serverName}__${toolName}`;
			tools.push(formattedName);
			debug.log('mcp', `✓ Allowed MCP tool: ${formattedName}`);
		});
	});

	debug.log('mcp', `Total allowed MCP tools: ${tools.length}`);

	return tools;
}

// ============================================================================
// Configuration Helper Functions
// ============================================================================

/**
 * Get server configuration by name
 */
export function getServerConfig(serverName: string) {
	return mcpServers[serverName];
}

/**
 * Check if a tool exists in server configuration
 */
export function getToolConfig(serverName: string, toolName: string): boolean {
	const server = getServerConfig(serverName);
	return server?.tools.includes(toolName as any) ?? false;
}

/**
 * Check if a server is enabled
 */
export function isServerEnabled(serverName: string): boolean {
	return mcpServers[serverName]?.enabled ?? false;
}

/**
 * Check if a tool is enabled
 */
export function isToolEnabled(serverName: string, toolName: string): boolean {
	const server = mcpServers[serverName];
	if (!server?.enabled) return false;

	return server.tools.includes(toolName as any);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse MCP tool name into components
 *
 * Format: mcp__{server-name}__{tool-name}
 * Example: "mcp__weather-service__get_temperature"
 */
export function parseMcpToolName(fullName: string): ParsedMcpToolName | null {
	if (!fullName.startsWith('mcp__')) {
		return null;
	}

	const withoutPrefix = fullName.replace('mcp__', '');
	const parts = withoutPrefix.split('__');

	if (parts.length !== 2) {
		debug.warn('mcp', `Invalid MCP tool name format: ${fullName}`);
		return null;
	}

	const [server, tool] = parts;

	return {
		server,
		tool,
		fullName
	};
}

/**
 * Check if a tool name is a custom MCP tool
 */
export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith('mcp__');
}

/**
 * Get all enabled server names
 */
export function getEnabledServerNames(): string[] {
	return Object.entries(mcpServers)
		.filter(([_, config]) => config.enabled)
		.map(([name, _]) => name);
}

/**
 * Get all enabled tool names for a specific server
 */
export function getEnabledToolsForServer(serverName: string): string[] {
	const serverConfig = mcpServers[serverName];
	if (!serverConfig?.enabled) {
		return [];
	}

	return serverConfig.tools.map((toolName) => `mcp__${serverName}__${toolName}`);
}

/**
 * Get statistics about MCP servers and tools
 */
export function getMcpStats() {
	const enabledServers = getEnabledServerNames();
	const allTools = getAllowedMcpTools();

	return {
		totalServers: Object.keys(mcpServers).length,
		enabledServers: enabledServers.length,
		totalTools: allTools.length,
		serverNames: enabledServers,
		toolNames: allTools
	};
}

// ============================================================================
// Open Code Tool Name Resolution (single source of truth)
// ============================================================================

/**
 * Resolve an Open Code tool name to our mcp__server__tool format.
 *
 * Open Code prefixes tool names with the MCP server name:
 * e.g. "clopen-mcp_open_new_tab" → "mcp__browser-automation__open_new_tab"
 *
 * This function strips the prefix and maps back using the mcpServers
 * registry — the SAME source that defines which tools exist.
 *
 * Works for both remote HTTP MCP and legacy stdio MCP (same naming convention).
 *
 * Returns null if the tool name is not one of our custom MCP tools.
 */
export function resolveOpenCodeToolName(toolName: string): string | null {
	// Already in our format
	if (toolName.startsWith('mcp__')) return toolName;

	// Strip Open Code MCP server prefix if present
	// Open Code prefixes with the server config key: "clopen-mcp_<tool>"
	let rawName = toolName;
	const ocPrefix = 'clopen-mcp_';
	if (rawName.startsWith(ocPrefix)) {
		rawName = rawName.slice(ocPrefix.length);
	}

	// Look up which server owns this tool
	for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
		if (!serverConfig.enabled) continue;
		if ((serverConfig.tools as readonly string[]).includes(rawName)) {
			return `mcp__${serverName}__${rawName}`;
		}
	}

	return null;
}

// ============================================================================
// Open Code MCP Configuration
// ============================================================================

/**
 * Get MCP configuration for Open Code engine.
 *
 * Open Code connects to a remote MCP HTTP server running in the main Clopen
 * process. Tool handlers execute in-process — no subprocess, no bridge.
 *
 * This is the Open Code equivalent of Claude Code's in-process MCP servers.
 */
export function getOpenCodeMcpConfig(): Record<string, McpRemoteConfig> {
	// Check if any servers are enabled
	const enabledServers = getEnabledServerNames();
	if (enabledServers.length === 0) {
		return {};
	}

	const port = SERVER_ENV.PORT;

	debug.log('mcp', `📦 Open Code MCP: remote server at http://localhost:${port}/mcp`);

	return {
		'clopen-mcp': {
			type: 'remote',
			url: `http://localhost:${port}/mcp`,
			enabled: true,
			timeout: 10000,
		},
	};
}
