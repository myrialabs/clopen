/**
 * MCP (Model Context Protocol) Custom Tools
 *
 * Main export point for the custom MCP tools system.
 *
 * Claude Code: in-process MCP servers via createSdkMcpServer()
 * Open Code:   remote HTTP MCP server via createRemoteMcpServer()
 *
 * Both use the same tool definitions from defineServer() in servers/helper.ts.
 */

// Type definitions
export type {
	ParsedMcpToolName,
	McpServerStatus
} from './types';

// Main configuration and all utilities
export {
	mcpServers,
	mcpServersConfig,
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
	getCodexMcpConfig,
	getCopilotMcpConfig,
	resolveOpenCodeToolName
} from './config';

// Server implementations
export * from './servers';

// Remote MCP HTTP server for Open Code
export { handleMcpRequest, closeMcpServer } from './remote-server';

// Project context service for MCP tool handlers
export { projectContextService } from './project-context';
