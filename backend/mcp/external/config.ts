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
import type { McpServerRow } from '$backend/database/queries';
import type { ResolvedExternalServer } from './types';

/** Codex flattens `mcp_servers.<name>.<key>` config to `--config` flags. */
type CodexMcpServerConfig = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	/**
	 * Streamable-HTTP auth headers. Codex rejects an inline `bearer_token` for
	 * streamable_http but accepts an `http_headers` table (the same field the
	 * internal `clopen-mcp` bridge uses), so the centrally-managed
	 * `Authorization: Bearer …` and any static API-key headers reach Codex.
	 */
	http_headers?: Record<string, string>;
};

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Parse a raw DB row into a connection-ready resolved server. */
export function resolveServerRow(row: McpServerRow): ResolvedExternalServer {
	const headers = parseJson<Record<string, string>>(row.headers, {});
	// Inject the Clopen-managed OAuth access token as a bearer header so EVERY
	// engine (Codex included) authenticates with the same token. A user-set
	// `Authorization` header always wins. `refreshExpiringExternalOAuth()` runs
	// at stream start, so the token read here is fresh.
	const oauth = row.oauth ? parseJson<{ accessToken?: string } | null>(row.oauth, null) : null;
	if (oauth?.accessToken && !headers.Authorization && !headers.authorization) {
		headers.Authorization = `Bearer ${oauth.accessToken}`;
	}
	return {
		id: row.id,
		slug: row.slug,
		namespace: externalNamespace(row.slug),
		name: row.name,
		transport: row.transport,
		command: row.command,
		args: parseJson<string[]>(row.args, []),
		env: parseJson<Record<string, string>>(row.env, {}),
		url: row.url,
		headers
	};
}

/**
 * Load every enabled external server from the DB, parsing JSON columns and
 * computing its `<slug>` namespace key.
 */
export function getEnabledExternalServers(): ResolvedExternalServer[] {
	// `mcp_servers` also holds INTERNAL (code-defined) rows used only for the
	// Settings listing + toggle — exclude them here so they're never emitted as
	// real external servers the engine would try to connect to.
	return mcpServerQueries.getEnabled().filter(row => row.source !== 'internal').map(resolveServerRow);
}

/**
 * A remote server with no configured static credential (API key / bearer
 * header) relies on OAuth. We turn on each engine's native OAuth
 * auto-detection for these so the engine runs the MCP authorization handshake
 * (dynamic client registration, RFC 7591) instead of hitting an
 * unauthenticated 401 and silently exposing zero tools — the failure that hid
 * `com-notion-mcp` on every non-Claude engine. Servers carrying a static
 * header are left as plain authenticated remotes.
 */
export function remoteNeedsOAuth(s: ResolvedExternalServer): boolean {
	return (s.transport === 'http' || s.transport === 'sse')
		&& !!s.url
		&& Object.keys(s.headers).length === 0;
}

/** Qwen OAuth fields for a credential-less remote (dynamic discovery). */
function remoteAuthQwen(s: ResolvedExternalServer): Partial<QwenMcpServerConfig> {
	if (!remoteNeedsOAuth(s)) return {};
	return { oauth: { enabled: true }, authProviderType: 'dynamic_discovery' };
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
			// `oauth` is intentionally left unset: Open Code's default is OAuth
			// auto-detection (set it to `false` only to opt out). Credential-less
			// remotes therefore get the authorization handshake for free; the
			// interactive sign-in is driven separately via the MCP auth flow.
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
			// `http_headers` carries the injected OAuth bearer (and any static API
			// key), matching the internal bridge — so Codex authenticates too.
			out[s.namespace] = {
				url: s.url,
				...(Object.keys(s.headers).length > 0 ? { http_headers: s.headers } : {})
			};
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
			// Leaving `oauthClientId` unset makes the Copilot runtime perform
			// dynamic client registration when the server demands OAuth. The
			// interactive consent is delegated to us via the `mcp.oauth_required`
			// event (see the Copilot adapter's MCP auth wiring).
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
			out[s.namespace] = { httpUrl: s.url, headers: s.headers, trust: true, ...remoteAuthQwen(s) };
		} else if (s.transport === 'sse' && s.url) {
			out[s.namespace] = { url: s.url, headers: s.headers, trust: true, ...remoteAuthQwen(s) };
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
