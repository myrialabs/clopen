/**
 * MCP (Model Context Protocol) — public facade.
 *
 * This is the ONLY entry point the rest of the backend imports from. It hides
 * the internal/external split and merges the two before handing config to an
 * engine adapter:
 *
 *   - INTERNAL (`./internal`) — custom tools defined in code via
 *     `defineServer()`. Claude runs them in-process; other engines reach them
 *     through the `/mcp` remote bridge (namespace `clopen-mcp`).
 *   - EXTERNAL (`./external`) — servers the user installs from the official
 *     MCP registry, stored in the `mcp_servers` table. Each occupies its own
 *     `<slug>` namespace and is proxied through the `/mcp/ext/<slug>` bridge
 *     (`./external/proxy.ts`) — the engine talks to Clopen, not the upstream.
 *
 * Adapters call `getEnabledMcpServers()` / `getXxxMcpConfig()` /
 * `resolveOpenCodeToolName()` here and receive the COMBINED view. The internal
 * builders (which only know about `clopen-mcp`) live in `./internal/config`
 * and are wrapped below.
 */

import type { McpExecutionContext } from '../engine/types';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import * as internal from './internal/config';
import * as external from './external/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
	ParsedMcpToolName,
	McpServerStatus
} from './internal/types';

// ---------------------------------------------------------------------------
// Internal config — re-exported unchanged (no external dimension)
// ---------------------------------------------------------------------------

export {
	mcpServers,
	mcpServersConfig,
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
	syncInternalServers,
	refreshInternalEnabledCache
} from './internal/config';

// Internal server implementations + registries
export * from './internal/servers';

// Remote MCP HTTP bridge (serves internal tools + external proxies to non-Claude engines)
export { handleMcpRequest, handleExternalMcpRequest, closeMcpServer } from './internal/remote-server';

// Project context service for MCP tool handlers
export { projectContextService } from './internal/project-context';

// Shared namespace constants/helpers
export {
	INTERNAL_BRIDGE_NAMESPACE,
	INTERNAL_PREFIX,
	externalNamespace,
	isInternalNamespace,
	slugifyRegistryName
} from './shared/constants';

// External catalog + types (used by the WS layer and Settings → MCP)
export { listRegistryServers, mapRegistryServer } from './external/registry-client';
export { getEnabledExternalServers, resolveServerRow, remoteNeedsOAuth } from './external/config';
export { probeServer } from './external/probe';
export type { McpHealth, McpHealthState } from './external/probe';
export {
	startAuthorization,
	completeAuthorization,
	getValidAccessToken,
	refreshExpiringExternalOAuth,
	hasPendingFlow,
	clearOAuth,
	loadOAuth
} from './external/oauth';
export type { CatalogServer, CatalogEnvVar, CatalogPage, ResolvedExternalServer } from './external/types';
export { parseMcpConfig } from './external/parse';
export type { ParsedMcpServer, ParsedField, ParseResult } from './external/parse';

// ---------------------------------------------------------------------------
// Merged config builders (internal `clopen-mcp` + external bare `<slug>`)
// ---------------------------------------------------------------------------

/** Claude Agent SDK `mcpServers`: in-process internal servers + external stdio/remote. */
export function getEnabledMcpServers(context?: McpExecutionContext): Record<string, McpServerConfig> {
	return {
		...internal.getEnabledMcpServers(context),
		...external.getClaudeExternalMcpConfig()
	};
}

/** Open Code MCP config: internal `clopen-mcp` remote bridge + external servers. */
export function getOpenCodeMcpConfig() {
	return {
		...internal.getOpenCodeMcpConfig(),
		...external.getOpenCodeExternalMcpConfig()
	};
}

/** Codex MCP config. */
export function getCodexMcpConfig() {
	return {
		...internal.getCodexMcpConfig(),
		...external.getCodexExternalMcpConfig()
	};
}

/** Copilot MCP config. */
export function getCopilotMcpConfig() {
	return {
		...internal.getCopilotMcpConfig(),
		...external.getCopilotExternalMcpConfig()
	};
}

/** Qwen Code MCP config. */
export function getQwenMcpConfig() {
	return {
		...internal.getQwenMcpConfig(),
		...external.getQwenExternalMcpConfig()
	};
}

/**
 * Resolve a remote-engine tool name to `mcp__<server>__<tool>`. Tries the
 * internal resolver (handles `clopen-mcp` + already-canonical names) first,
 * then the external resolver (handles `<slug>` namespaces).
 */
export function resolveOpenCodeToolName(toolName: string): string | null {
	return internal.resolveOpenCodeToolName(toolName) ?? external.resolveExternalToolName(toolName);
}
