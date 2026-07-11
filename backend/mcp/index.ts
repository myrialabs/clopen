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
export { listExternalServerTools, callExternalServerTool } from './external/proxy';
export { parseToolOverrides, resolveToolExposure, pruneToolOverrides, MCP_ENGINES } from './external/tools';
export type { ToolExposure } from './external/tools';
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

// Each builder takes an optional `profileFilter` — the set of connector slugs an
// active Profile bundles. It restricts the EXTERNAL servers only; Clopen's own
// internal `clopen-mcp` tools are always present. `undefined` = no active profile
// (or the profile bundles no connector) → every enabled external server, i.e. the
// existing behaviour, unchanged.

/** Claude Agent SDK `mcpServers`: in-process internal servers + external stdio/remote. */
export function getEnabledMcpServers(context?: McpExecutionContext, profileFilter?: Set<string>): Record<string, McpServerConfig> {
	return {
		...internal.getEnabledMcpServers(context, profileFilter),
		...external.getClaudeExternalMcpConfig(profileFilter)
	};
}

/** Open Code MCP config: internal `clopen-mcp` remote bridge + external servers. */
export function getOpenCodeMcpConfig(profileFilter?: Set<string>) {
	return {
		...internal.getOpenCodeMcpConfig(profileFilter),
		...external.getOpenCodeExternalMcpConfig(profileFilter)
	};
}

/** Codex MCP config. */
export function getCodexMcpConfig(profileFilter?: Set<string>) {
	return {
		...internal.getCodexMcpConfig(profileFilter),
		...external.getCodexExternalMcpConfig(profileFilter)
	};
}

/** Copilot MCP config. */
export function getCopilotMcpConfig(profileFilter?: Set<string>) {
	return {
		...internal.getCopilotMcpConfig(profileFilter),
		...external.getCopilotExternalMcpConfig(profileFilter)
	};
}

/** Qwen Code MCP config. */
export function getQwenMcpConfig(profileFilter?: Set<string>) {
	return {
		...internal.getQwenMcpConfig(profileFilter),
		...external.getQwenExternalMcpConfig(profileFilter)
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

/**
 * Open Code tool ids to DISABLE for INTERNAL connectors excluded by an active
 * Profile, for the per-prompt `tools` map (per-session → concurrency-safe). All
 * internal tools ride the single `clopen-mcp` bridge, which is all-or-nothing at
 * the MCP-config level, so per-connector scoping must happen here. EXTERNAL
 * connectors are handled at the server level instead — each is its own MCP entry,
 * dropped from the per-Profile server's config when excluded (see
 * `getOpenCodeMcpConfig(profileFilter)` in the server pool). `undefined` filter
 * (profile doesn't constrain connectors) → none.
 */
export function getOpenCodeProfileDisabledToolIds(profileFilter?: Set<string>): string[] {
	return internal.getOpenCodeProfileDisabledInternalToolIds(profileFilter);
}
