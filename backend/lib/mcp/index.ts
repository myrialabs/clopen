/**
 * MCP (Model Context Protocol) Custom Tools
 *
 * Main export point for the custom MCP tools system.
 */

// Type definitions
export type {
	ParsedMcpToolName,
	McpServerStatus
} from './types';

// Main configuration and all utilities
export {
	mcpServers,
	getEnabledMcpServers,
	getAllowedMcpTools,
	getServerConfig,
	getToolConfig,
	isServerEnabled,
	isToolEnabled,
	parseMcpToolName,
	isMcpTool,
	getEnabledServerNames,
	getEnabledToolsForServer,
	getMcpStats,
	getOpenCodeMcpConfig,
	resolveOpenCodeToolName
} from './config';

// Server implementations
export * from './servers';

// Project context service for MCP tool handlers
export { projectContextService } from './project-context';
