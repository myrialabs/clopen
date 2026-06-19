/**
 * External MCP — per-engine config builders.
 *
 * Reads enabled servers from the `mcp_servers` table and emits each engine's
 * native MCP config shape. Every external server occupies its OWN namespace
 * key (its bare `<slug>`; the `clopen` prefix is reserved for internal) — disjoint from the internal `clopen-mcp` bridge — so the
 * two systems never collide. The facade (`backend/mcp/index.ts`) merges these
 * with the internal config before handing them to an adapter.
 *
 * Unlike internal tools, external servers are real MCP servers the engine
 * connects to directly (stdio subprocess or remote HTTP), NOT routed through
 * Clopen's in-process `/mcp` bridge.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpLocalConfig, McpRemoteConfig } from '@opencode-ai/sdk';
import type { MCPServerConfig as CopilotMcpServerConfig } from '@github/copilot-sdk';
import type { CLIMcpServerConfig as QwenMcpServerConfig } from '@qwen-code/sdk';
import { debug } from '$shared/utils/logger';
import { mcpServerQueries } from '$backend/database/queries';
import { externalNamespace } from '../shared/constants';
import type { ResolvedExternalServer } from './types';

/** Codex flattens `mcp_servers.<name>.<key>` config to `--config` flags. */
type CodexMcpServerConfig = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
};

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Load every enabled external server from the DB, parsing JSON columns and
 * computing its `<slug>` namespace key.
 */
export function getEnabledExternalServers(): ResolvedExternalServer[] {
	// `mcp_servers` also holds INTERNAL (code-defined) rows used only for the
	// Settings listing + toggle — exclude them here so they're never emitted as
	// real external servers the engine would try to connect to.
	return mcpServerQueries.getEnabled().filter(row => row.source !== 'internal').map(row => ({
		id: row.id,
		slug: row.slug,
		namespace: externalNamespace(row.slug),
		name: row.name,
		transport: row.transport,
		command: row.command,
		args: parseJson<string[]>(row.args, []),
		env: parseJson<Record<string, string>>(row.env, {}),
		url: row.url,
		headers: parseJson<Record<string, string>>(row.headers, {})
	}));
}

// ---------------------------------------------------------------------------
// Per-engine builders
// ---------------------------------------------------------------------------

/** Claude Agent SDK: stdio / sse / http config keyed by namespace. */
export function getClaudeExternalMcpConfig(): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		if (s.transport === 'stdio' && s.command) {
			out[s.namespace] = { type: 'stdio', command: s.command, args: s.args, env: s.env };
		} else if ((s.transport === 'http' || s.transport === 'sse') && s.url) {
			out[s.namespace] = {
				type: s.transport,
				url: s.url,
				...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {})
			};
		}
	}
	logBuilt('Claude', out);
	return out;
}

/** Open Code: `McpLocalConfig` (stdio) / `McpRemoteConfig` (http/sse). */
export function getOpenCodeExternalMcpConfig(): Record<string, McpLocalConfig | McpRemoteConfig> {
	const out: Record<string, McpLocalConfig | McpRemoteConfig> = {};
	for (const s of getEnabledExternalServers()) {
		if (s.transport === 'stdio' && s.command) {
			out[s.namespace] = {
				type: 'local',
				command: [s.command, ...s.args],
				...(Object.keys(s.env).length > 0 ? { environment: s.env } : {}),
				enabled: true
			};
		} else if ((s.transport === 'http' || s.transport === 'sse') && s.url) {
			out[s.namespace] = {
				type: 'remote',
				url: s.url,
				enabled: true,
				...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {})
			};
		}
	}
	logBuilt('Open Code', out);
	return out;
}

/**
 * Codex: `mcp_servers.<name>` accepts a command (stdio) or url. Note: Codex
 * requires per-tool `approval_mode` to auto-approve, but external tool names
 * aren't known at install time (config-only, lazy spawn), so external MCP
 * tool calls may be cancelled in non-interactive `codex exec`. The server is
 * still registered so interactive/known-tool flows work.
 */
export function getCodexExternalMcpConfig(): Record<string, CodexMcpServerConfig> {
	const out: Record<string, CodexMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		if (s.transport === 'stdio' && s.command) {
			out[s.namespace] = {
				command: s.command,
				args: s.args,
				...(Object.keys(s.env).length > 0 ? { env: s.env } : {})
			};
		} else if ((s.transport === 'http' || s.transport === 'sse') && s.url) {
			out[s.namespace] = { url: s.url };
		}
	}
	logBuilt('Codex', out);
	return out;
}

/** Copilot: `MCPStdioServerConfig` (stdio) / `MCPHTTPServerConfig` (http/sse). */
export function getCopilotExternalMcpConfig(): Record<string, CopilotMcpServerConfig> {
	const out: Record<string, CopilotMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		if (s.transport === 'stdio' && s.command) {
			out[s.namespace] = { type: 'local', command: s.command, args: s.args, env: s.env };
		} else if ((s.transport === 'http' || s.transport === 'sse') && s.url) {
			out[s.namespace] = {
				type: s.transport,
				url: s.url,
				...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {})
			};
		}
	}
	logBuilt('Copilot', out);
	return out;
}

/** Qwen Code: `CLIMcpServerConfig` — command (stdio) or url/httpUrl (remote). */
export function getQwenExternalMcpConfig(): Record<string, QwenMcpServerConfig> {
	const out: Record<string, QwenMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		if (s.transport === 'stdio' && s.command) {
			out[s.namespace] = { command: s.command, args: s.args, env: s.env, trust: true };
		} else if (s.transport === 'http' && s.url) {
			out[s.namespace] = { httpUrl: s.url, headers: s.headers, trust: true };
		} else if (s.transport === 'sse' && s.url) {
			out[s.namespace] = { url: s.url, headers: s.headers, trust: true };
		}
	}
	logBuilt('Qwen', out);
	return out;
}

// ---------------------------------------------------------------------------
// Tool name resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an external MCP tool name (as a non-Claude engine reports it) into
 * the canonical `mcp__<slug>__<tool>` form.
 *
 * Non-Claude engines join the namespace key and the bare tool name with a
 * separator that varies by SDK (`_` for Open Code, `-` for Copilot). Because
 * external namespaces are bare slugs that may themselves contain `-`, so splitting blindly is ambiguous
 * — so we iterate the known enabled namespaces and strip whichever matches.
 * Claude already emits `mcp__<slug>__<tool>`, handled by the internal
 * resolver's pass-through.
 *
 * Returns null if the name doesn't belong to any enabled external server.
 */
export function resolveExternalToolName(toolName: string): string | null {
	for (const s of getEnabledExternalServers()) {
		const ns = s.namespace;
		if (toolName.startsWith(`mcp__${ns}__`)) return toolName;
		for (const sep of ['_', '-']) {
			const prefix = `${ns}${sep}`;
			if (toolName.startsWith(prefix)) {
				return `mcp__${ns}__${toolName.slice(prefix.length)}`;
			}
		}
	}
	return null;
}

function logBuilt(engine: string, out: Record<string, unknown>): void {
	const count = Object.keys(out).length;
	if (count > 0) debug.log('mcp', `🧩 ${engine} external MCP: ${count} server(s)`);
}
