/**
 * MCP (Model Context Protocol) Custom Tools - Type Definitions
 *
 * This file contains all TypeScript types and interfaces used across
 * the custom MCP tools system.
 */

import type { serverMetadata } from './servers';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

/**
 * Extract server names from metadata registry
 */
export type ServerName = keyof typeof serverMetadata;

/**
 * Extract tool names from a specific server
 * Automatically inferred from server metadata
 */
export type ToolsForServer<S extends ServerName> = (typeof serverMetadata)[S]['tools'][number];

/**
 * Configuration for an MCP server (user-defined)
 */
export type ServerConfig<S extends ServerName = ServerName> = {
	/** Whether this server is enabled */
	enabled: boolean;
	/** List of enabled tool names for this server */
	tools: readonly ToolsForServer<S>[];
};

/**
 * Complete server configuration with instance (internal use)
 */
export type McpServerConfigWithInstance<S extends ServerName = ServerName> = ServerConfig<S> & {
	instance: McpSdkServerConfigWithInstance;
};

/**
 * Parsed MCP tool name
 * Format: mcp__server-name__tool-name
 */
export interface ParsedMcpToolName {
	/** Server name (e.g., "browser-automation") */
	server: string;
	/** Tool name (e.g., "navigate") */
	tool: string;
	/** Full tool name (e.g., "mcp__browser-automation__navigate") */
	fullName: string;
}

/**
 * MCP server status from SDK
 */
export interface McpServerStatus {
	/** Server name */
	name: string;
	/** Connection status */
	status: 'connected' | 'failed' | 'needs-auth' | 'pending';
	/** Server information if connected */
	serverInfo?: {
		name: string;
		version: string;
	};
}
