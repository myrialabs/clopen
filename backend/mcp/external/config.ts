/**
 * External MCP — per-engine config builders.
 *
 * Every enabled external server is exposed to engines through Clopen's OWN
 * Streamable-HTTP bridge at `/mcp/ext/<slug>` (see `./proxy.ts`), NOT by
 * pointing the engine straight at the third-party stdio/HTTP server. Each
 * server keeps its bare `<slug>` namespace (the `clopen` prefix is reserved
 * for internal) — disjoint from the internal `clopen-mcp` bridge — so the two
 * systems never collide.
 *
 * Routing through the bridge means every engine receives the IDENTICAL shape:
 * a loopback remote URL plus the service-token header. The real upstream
 * transport (stdio/http/sse) and its OAuth/API-key credential are handled once,
 * inside the proxy — so a new engine adapter needs no per-transport branching,
 * and engines are shielded from upstream servers whose tool schemas would
 * otherwise crash their MCP client (see `./proxy.ts`).
 *
 * The facade (`backend/mcp/index.ts`) merges these with the internal config
 * before handing them to an adapter.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpRemoteConfig } from '@opencode-ai/sdk';
import type { MCPHTTPServerConfig as CopilotMcpServerConfig } from '@github/copilot-sdk';
import type { CLIMcpServerConfig as QwenMcpServerConfig } from '@qwen-code/sdk';
import { debug } from '$shared/utils/logger';
import { mcpServerQueries } from '$backend/database/queries';
import { externalNamespace, MCP_TOOL_CALL_TIMEOUT_MS } from '../shared/constants';
import { getMcpServiceToken } from '../internal/service-token';
import { SERVER_ENV } from '../../utils/env';
import type { McpServerRow } from '$backend/database/queries';
import type { ResolvedExternalServer } from './types';

/**
 * Codex `mcp_servers.<name>` config, flattened by the SDK to `--config` flags.
 * Each external server is a Streamable-HTTP remote pointing at our bridge;
 * `http_headers` carries the service-token bearer (Codex rejects an inline
 * `bearer_token` for `streamable_http`).
 */
type CodexMcpServerConfig = {
	url: string;
	http_headers?: Record<string, string>;
};

/** Loopback URL of the per-server external proxy bridge for `slug`. */
function bridgeUrl(slug: string): string {
	return `http://localhost:${SERVER_ENV.PORT}/mcp/ext/${slug}`;
}

/** The service-token bearer header every engine→bridge hop carries. */
function serviceAuthHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${getMcpServiceToken()}` };
}

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

// ---------------------------------------------------------------------------
// Per-engine builders
//
// Every external server, regardless of its real transport, is emitted as a
// Streamable-HTTP remote pointing at our `/mcp/ext/<slug>` proxy. The only
// per-engine difference is the SDK's config shape (field names) — the URL,
// namespace key, and service-token header are identical. The upstream
// transport + credential live inside the proxy (see ./proxy.ts).
// ---------------------------------------------------------------------------

/** Claude Agent SDK: Streamable-HTTP remote keyed by namespace. */
export function getClaudeExternalMcpConfig(): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		out[s.namespace] = { type: 'http', url: bridgeUrl(s.slug), headers: serviceAuthHeaders() };
	}
	logBuilt('Claude', out);
	return out;
}

/** Open Code: `McpRemoteConfig` pointing at the bridge proxy. */
export function getOpenCodeExternalMcpConfig(): Record<string, McpRemoteConfig> {
	const out: Record<string, McpRemoteConfig> = {};
	for (const s of getEnabledExternalServers()) {
		out[s.namespace] = {
			type: 'remote',
			url: bridgeUrl(s.slug),
			enabled: true,
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			headers: serviceAuthHeaders()
		};
	}
	logBuilt('Open Code', out);
	return out;
}

/**
 * Codex: `mcp_servers.<name>.url` pointing at the bridge proxy.
 *
 * Note: Codex still requires per-tool `approval_mode` to auto-approve in
 * non-interactive `codex exec`, and external tool names aren't known when this
 * synchronous builder runs — so external MCP tool calls may be cancelled there.
 * The server is registered so interactive/known-tool flows work; this limit is
 * unchanged by the proxy.
 */
export function getCodexExternalMcpConfig(): Record<string, CodexMcpServerConfig> {
	const out: Record<string, CodexMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		out[s.namespace] = { url: bridgeUrl(s.slug), http_headers: serviceAuthHeaders() };
	}
	logBuilt('Codex', out);
	return out;
}

/** Copilot: `MCPHTTPServerConfig` pointing at the bridge proxy. */
export function getCopilotExternalMcpConfig(): Record<string, CopilotMcpServerConfig> {
	const out: Record<string, CopilotMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		// `tools: ['*']` makes the Copilot runtime expose ALL of the proxy's
		// tools. Leaving it unset relies on the SDK's documented "undefined =
		// all" default, which the bundled CLI does not honour for dynamically
		// discovered servers — the tools never reach the model.
		out[s.namespace] = {
			type: 'http',
			url: bridgeUrl(s.slug),
			tools: ['*'],
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			headers: serviceAuthHeaders()
		};
	}
	logBuilt('Copilot', out);
	return out;
}

/** Qwen Code: `CLIMcpServerConfig` Streamable-HTTP (`httpUrl`) at the bridge proxy. */
export function getQwenExternalMcpConfig(): Record<string, QwenMcpServerConfig> {
	const out: Record<string, QwenMcpServerConfig> = {};
	for (const s of getEnabledExternalServers()) {
		out[s.namespace] = {
			httpUrl: bridgeUrl(s.slug),
			timeout: MCP_TOOL_CALL_TIMEOUT_MS,
			trust: true,
			headers: serviceAuthHeaders()
		};
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
