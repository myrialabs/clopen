/**
 * MCP Custom Tools Configuration & Registry
 *
 * This file combines server registry and configuration in one place
 * to avoid duplication and make it easier to add new servers.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpRemoteConfig } from '@opencode-ai/sdk';
import type { MCPHTTPServerConfig } from '@github/copilot-sdk';
import type { CLIMcpServerConfig as QwenMcpServerConfig } from '@qwen-code/sdk';
import type { ServerConfig, ParsedMcpToolName, ServerName } from './types';
import type { McpExecutionContext } from '../../engine/types';
import { serverRegistry, serverFactories, serverMetadata } from './servers';
import { projectContextService } from './project-context';
import { mcpServerQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { SERVER_ENV } from '../../utils/env';
import { validateMcpOutput } from './output-validator';
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../shared/constants';
import { getMcpServiceToken } from './service-token';

/**
 * User-defined MCP Servers Configuration
 *
 * Define your server configuration here. Only specify `enabled` and `tools`.
 * Server instances are automatically merged from the registry.
 *
 * Type-safe: Server names and tool names are validated at compile time!
 */
export const mcpServersConfig: Record<ServerName, ServerConfig> = {
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
// Runtime enabled state (DB-backed)
// ============================================================================

/**
 * In-memory mirror of each internal server's enabled toggle, keyed by server
 * name (= the seeded `slug`). The DB row in `mcp_servers` is the source of
 * truth; this cache avoids a query on every tool-name resolution. Refreshed at
 * startup (after `syncInternalServers`) and whenever the user toggles a server.
 */
let internalEnabledCache: Record<string, boolean> | null = null;

/** Reload the internal enabled-state cache from the DB. */
export function refreshInternalEnabledCache(): void {
	const map: Record<string, boolean> = {};
	for (const row of mcpServerQueries.getBySource('internal')) {
		map[row.slug] = row.is_enabled === 1;
	}
	internalEnabledCache = map;
}

/**
 * Whether an internal server is enabled right now. Combines the static config
 * (which tools exist) with the user's DB-backed toggle. Defaults to enabled if
 * the row hasn't been seeded yet (sync runs at startup, before any stream).
 */
function serverEnabled(serverName: string): boolean {
	const cfg = mcpServers[serverName];
	if (!cfg?.enabled) return false;
	if (internalEnabledCache === null) refreshInternalEnabledCache();
	return internalEnabledCache?.[serverName] ?? true;
}

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
export function getEnabledMcpServers(context?: McpExecutionContext, profileFilter?: Set<string>): Record<string, McpServerConfig> {
	const enabledServers: Record<string, McpServerConfig> = {};
	const active = new Set(activeInternalServerNames(profileFilter));

	Object.entries(mcpServers).forEach(([serverName, serverConfig]) => {
		if (active.has(serverName)) {
			if (context) {
				// Create context-bound instance: wrap each tool handler so
				// AsyncLocalStorage context is restored on invocation, then
				// short-circuit if the owning stream's AbortSignal has fired
				// — handler never runs, no half-completed browser ops.
				const meta = serverMetadata[serverName as ServerName];
				const sdkTools = (serverConfig.tools as readonly string[]).map(toolName => {
					const def = meta.toolDefs[toolName];
					const boundHandler = async (args: any) => {
						return projectContextService.runWithContextAsync(context, async () => {
							const signal = projectContextService.getCurrentSignal();
							if (signal?.aborted) {
								return abortedToolResult(toolName);
							}
							const result = await def.handler(args);
							result.content = validateMcpOutput(result.content, toolName);
							return result;
						});
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
 * Standard MCP error response when a tool call is rejected because the
 * owning chat stream has been cancelled. Returned by both the in-process
 * (Claude) wrapper and the remote-HTTP wrapper so engines see a consistent
 * "tool refused" outcome no matter which transport they used.
 */
function abortedToolResult(toolName: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
	return {
		content: [{ type: 'text' as const, text: `Tool ${toolName} was cancelled because the chat stream was interrupted.` }],
		isError: true,
	};
}

/**
 * Re-export for use by `backend/mcp/servers/helper.ts::createRemoteMcpServer`,
 * which wraps remote-HTTP handlers with the same abort check.
 */
export { abortedToolResult };

/**
 * Get list of all allowed MCP tool names
 *
 * Tool names follow the format: mcp__{server-name}__{tool-name}
 * Example: "mcp__browser-automation__navigate"
 */
export function getAllowedMcpTools(): string[] {
	const tools: string[] = [];

	Object.entries(mcpServers).forEach(([serverName, serverConfig]) => {
		if (!serverEnabled(serverName)) return;

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
	return serverEnabled(serverName);
}

/**
 * Check if a tool is enabled
 */
export function isToolEnabled(serverName: string, toolName: string): boolean {
	const server = mcpServers[serverName];
	if (!server || !serverEnabled(serverName)) return false;

	return server.tools.includes(toolName as any);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse MCP tool name into components
 *
 * Format: mcp__{server-name}__{tool-name}
 * Example: "mcp__browser-automation__navigate"
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
		.filter(([name]) => serverEnabled(name))
		.map(([name]) => name);
}

/**
 * Internal server names ACTIVE for a stream. When a Profile is active, its
 * referenced connector set is the source of truth — a referenced internal server
 * counts even if globally disabled, and one NOT referenced is excluded (built-in
 * connectors appear in the profile's Connectors picker, so this is an explicit
 * choice). Without a profile, every globally-enabled server is active (unchanged).
 */
export function activeInternalServerNames(profileFilter?: Set<string>): string[] {
	return Object.keys(mcpServers).filter(name =>
		profileFilter ? profileFilter.has(name) : serverEnabled(name)
	);
}

/**
 * Get all enabled tool names for a specific server
 */
export function getEnabledToolsForServer(serverName: string): string[] {
	const serverConfig = mcpServers[serverName];
	if (!serverConfig || !serverEnabled(serverName)) {
		return [];
	}

	return serverConfig.tools.map((toolName) => `mcp__${serverName}__${toolName}`);
}

/**
 * Open Code tool ids (`clopen-mcp_<tool>`) for INTERNAL connectors EXCLUDED by an
 * active Profile — every globally-enabled internal server whose slug is NOT in the
 * profile's connector set. Fed to Open Code's per-prompt `tools` disable map so
 * those tools are removed for THIS session, even though the persistent server was
 * built with every enabled connector. `undefined` filter (profile doesn't
 * constrain connectors) → none. All internal tools share the single `clopen-mcp`
 * bridge namespace, so the id is `clopen-mcp_<tool>` regardless of owning server.
 */
export function getOpenCodeProfileDisabledInternalToolIds(profileFilter?: Set<string>): string[] {
	if (!profileFilter) return [];
	const ids: string[] = [];
	for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
		if (!serverEnabled(serverName)) continue;   // not in the running config anyway
		if (profileFilter.has(serverName)) continue; // allowed by the profile
		for (const toolName of serverConfig.tools as readonly string[]) {
			ids.push(`clopen-mcp_${toolName}`);
		}
	}
	return ids;
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
// Internal server ↔ DB sync
// ============================================================================

/**
 * Mirror the code-defined internal servers into the `mcp_servers` table so
 * Settings → MCP can list them alongside external servers and the user can
 * toggle them on/off. Definitions stay the source of truth in code; the DB row
 * only carries display metadata + the enabled flag.
 *
 * Idempotent: refreshes title/description/version for known servers (preserving
 * the user's enabled toggle), seeds new ones as enabled, and prunes rows whose
 * code definition was removed. Call once at startup, after the DB is ready.
 */
export function syncInternalServers(): void {
	const metas = Object.values(serverMetadata) as Array<{
		name: string;
		title: string;
		description: string;
		version: string;
	}>;
	const slugs: string[] = [];
	for (const meta of metas) {
		mcpServerQueries.upsertInternal({
			slug: meta.name,
			name: meta.title,
			description: meta.description,
			version: meta.version
		});
		slugs.push(meta.name);
	}
	mcpServerQueries.pruneInternalExcept(slugs);
	refreshInternalEnabledCache();
	debug.log('mcp', `🔄 Synced ${slugs.length} internal MCP server(s) to DB`);
}

// ============================================================================
// Open Code Tool Name Resolution (single source of truth)
// ============================================================================

/**
 * Resolve a remote-MCP tool name to our mcp__server__tool format.
 *
 * Different SDKs prepend the MCP server config key (`clopen-mcp`) to tool
 * names with different separators:
 *   - Open Code:  "clopen-mcp_open_new_tab"          (underscore)
 *   - Copilot:    "clopen-mcp-open_new_tab"          (hyphen)
 *   - Codex:      "open_new_tab"                     (no prefix; mcpServerName carried separately)
 *   - Qwen Code:  "mcp__clopen-mcp__open_new_tab"    (already mcp-prefixed using OUR namespace key)
 *
 * This function strips whichever prefix is present and maps the bare tool
 * name back using the `mcpServers` registry — the SAME source of truth that
 * defines which tools exist.
 *
 * Returns null if the tool name is not one of our custom MCP tools.
 */
export function resolveOpenCodeToolName(toolName: string): string | null {
	// Strip the remote-MCP server prefix if present. Both `_` and `-` are
	// observed in the wild depending on the engine's SDK; Qwen prepends the
	// full `mcp__<namespace>__` form so the bare tool name still needs to be
	// re-resolved against the registry to land on the correct server alias
	// (`mcp__browser-automation__open_new_tab`, not `mcp__clopen-mcp__...`).
	let rawName = toolName;
	let strippedNamespace = false;
	for (const prefix of ['mcp__clopen-mcp__', 'clopen-mcp_', 'clopen-mcp-']) {
		if (rawName.startsWith(prefix)) {
			rawName = rawName.slice(prefix.length);
			strippedNamespace = true;
			break;
		}
	}

	// Already in our canonical format and not the legacy double-prefixed
	// `mcp__clopen-mcp__<tool>` shape — pass through unchanged.
	if (!strippedNamespace && rawName.startsWith('mcp__')) return rawName;

	// Look up which server owns this tool
	for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
		if (!serverEnabled(serverName)) continue;
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
export function getOpenCodeMcpConfig(profileFilter?: Set<string>): Record<string, McpRemoteConfig> {
	// Drop the internal bridge entirely when an active profile excludes every
	// internal connector (else include it; the bridge serves the enabled ones).
	const enabledServers = activeInternalServerNames(profileFilter);
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
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			headers: { Authorization: `Bearer ${getMcpServiceToken()}` },
		},
	};
}

// ============================================================================
// Codex MCP Configuration
// ============================================================================

/**
 * Per-MCP-server config shape consumed by the Codex CLI.
 *
 * Mirrors the subset of `RawMcpServerConfig` we actually emit. The SDK
 * flattens this object to `--config mcp_servers.<server>.<key>=<value>` flags
 * on every `codex exec` invocation.
 */
type CodexMcpServerConfig = {
	url: string;
	http_headers?: Record<string, string>;
	tools?: Record<string, { approval_mode: 'auto' | 'prompt' | 'approve' }>;
};

/**
 * Get MCP configuration for Codex engine.
 *
 * Codex's CLI accepts an `mcp_servers.<name>.url` config that points at any
 * Streamable HTTP MCP endpoint. We reuse the SAME `/mcp` URL Open Code
 * already consumes — no new HTTP server, no per-engine bridge. Tool handlers
 * execute in-process in the Clopen backend.
 *
 * Approval: in non-interactive `codex exec` mode there is no UI to approve
 * MCP tool calls, so the CLI auto-cancels them with
 * "Error: user cancelled MCP tool call". Codex has no top-level
 * "auto-approve all MCP" switch — it only exposes per-tool
 * `mcp_servers.<name>.tools.<tool>.approval_mode`. We enumerate every
 * enabled tool here and set `approval_mode = "approve"` so the subprocess
 * runs them without asking. Open Code achieves the same outcome by replying
 * to permission events at runtime — Codex requires the decision up-front.
 *
 * The shape returned here is flattened by the Codex SDK into
 * `--config mcp_servers.clopen-mcp.<dotted-key>=<value>` flags when the SDK
 * invokes the CLI subprocess for each turn.
 */
export function getCodexMcpConfig(profileFilter?: Set<string>): Record<string, CodexMcpServerConfig> {
	const enabledServers = activeInternalServerNames(profileFilter);
	if (enabledServers.length === 0) {
		return {};
	}

	const port = SERVER_ENV.PORT;

	const tools: Record<string, { approval_mode: 'approve' }> = {};
	for (const serverName of enabledServers) {
		const serverConfig = mcpServers[serverName];
		for (const toolName of serverConfig.tools as readonly string[]) {
			tools[toolName] = { approval_mode: 'approve' };
		}
	}

	debug.log('mcp', `📦 Codex MCP: remote server at http://localhost:${port}/mcp (auto-approving ${Object.keys(tools).length} tools)`);

	return {
		'clopen-mcp': {
			url: `http://localhost:${port}/mcp`,
			http_headers: { Authorization: `Bearer ${getMcpServiceToken()}` },
			tools,
		},
	};
}

// ============================================================================
// Copilot MCP Configuration
// ============================================================================

/**
 * Get MCP configuration for the Copilot engine.
 *
 * The Copilot SDK accepts a `mcpServers` map on both `SessionConfig` and
 * `ResumeSessionConfig` and supports the streamable-HTTP transport directly
 * (`MCPHTTPServerConfig` with `type: 'http'`). We reuse the SAME `/mcp` URL
 * Open Code and Codex already consume — no new HTTP server, no per-engine
 * bridge. Tool handlers execute in-process in the Clopen backend.
 *
 * Approval: Copilot already auto-approves every tool call via
 * `onPermissionRequest: approveAll` in `copilot/stream.ts`, which covers MCP
 * tools too. No per-tool approval enumeration is required (unlike Codex).
 *
 * The `tools` field lists the bare tool names exposed by our remote MCP
 * server. The SDK delivers tool calls back with `mcpServerName: 'clopen-mcp'`
 * + the bare tool name; `mapCopilotToolName()` then routes them through
 * `resolveOpenCodeToolName()` to recover the canonical
 * `mcp__<server>__<tool>` form.
 */
export function getCopilotMcpConfig(profileFilter?: Set<string>): Record<string, MCPHTTPServerConfig> {
	const enabledServers = activeInternalServerNames(profileFilter);
	if (enabledServers.length === 0) {
		return {};
	}

	const port = SERVER_ENV.PORT;

	const tools: string[] = [];
	for (const serverName of enabledServers) {
		const serverConfig = mcpServers[serverName];
		for (const toolName of serverConfig.tools as readonly string[]) {
			tools.push(toolName);
		}
	}

	debug.log('mcp', `📦 Copilot MCP: remote server at http://localhost:${port}/mcp (${tools.length} tools)`);

	return {
		'clopen-mcp': {
			type: 'http',
			url: `http://localhost:${port}/mcp`,
			tools,
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			headers: { Authorization: `Bearer ${getMcpServiceToken()}` },
		},
	};
}

// ============================================================================
// Qwen Code MCP Configuration
// ============================================================================

/**
 * Get MCP configuration for the Qwen Code engine.
 *
 * The Qwen Code SDK / CLI accepts a `mcpServers` map keyed by server name with
 * a `CLIMcpServerConfig` value that supports the Streamable-HTTP transport via
 * `httpUrl`. We reuse the SAME `/mcp` URL Open Code, Codex and Copilot already
 * consume — no new HTTP server, no per-engine bridge. Tool handlers run
 * in-process in the Clopen backend (README §9.12).
 *
 * Approval: the Qwen adapter uses `permissionMode: 'default'` with a
 * `canUseTool` callback that auto-allows everything. `AskUserQuestion` is
 * blocked at the SDK level via `excludeTools` (highest permission priority),
 * so the model never sees it. The callback covers MCP tool calls too — no
 * per-tool enumeration needed.
 */
export function getQwenMcpConfig(profileFilter?: Set<string>): Record<string, QwenMcpServerConfig> {
	const enabledServers = activeInternalServerNames(profileFilter);
	if (enabledServers.length === 0) {
		return {};
	}

	const port = SERVER_ENV.PORT;

	const includeTools: string[] = [];
	for (const serverName of enabledServers) {
		const serverConfig = mcpServers[serverName];
		for (const toolName of serverConfig.tools as readonly string[]) {
			includeTools.push(toolName);
		}
	}

	debug.log('mcp', `📦 Qwen MCP: remote server at http://localhost:${port}/mcp (${includeTools.length} tools)`);

	return {
		'clopen-mcp': {
			httpUrl: `http://localhost:${port}/mcp`,
			includeTools,
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			trust: true,
			headers: { Authorization: `Bearer ${getMcpServiceToken()}` },
		},
	};
}
