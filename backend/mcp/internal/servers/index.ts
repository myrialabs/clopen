/**
 * MCP Servers Registry
 *
 * This file exports all custom MCP server implementations and provides
 * a type-safe registry for server configuration.
 *
 * To add a new server:
 * 1. Create your server file (e.g., ./my-server.ts) using defineServer
 * 2. Import it and add to the allServers array below
 * 3. Done! Registries are auto-built and type-safe.
 */

import browserAutomation from './browser-automation/index';
import { buildServerRegistries } from './helper';

// Re-export types and remote server factory
export type { RawToolDef } from './helper';
export { createRemoteMcpServer } from './helper';

/**
 * All MCP Servers
 *
 * Simply import and add new servers to this array.
 * Metadata and registry will be automatically built.
 */
export const allServers = [
	browserAutomation,
	// Add more servers here...
] as const;

/**
 * Auto-build registries from server array
 */
const { metadata, registry, factories } = buildServerRegistries(allServers);

/**
 * Server Metadata Registry - Defines available servers and their tools
 */
export const serverMetadata = metadata;

/**
 * Server Instance Registry - Maps server names to SDK instances
 */
export const serverRegistry = registry;

/**
 * Server Factory Registry - Creates fresh SDK instances (safe for concurrent streams)
 */
export const serverFactories = factories;