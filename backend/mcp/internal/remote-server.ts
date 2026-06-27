/**
 * Remote MCP HTTP bridge (Streamable HTTP transport, works natively with Bun).
 *
 * Mounts TWO kinds of endpoint for every non-Claude engine:
 *
 *   - `/mcp` — the INTERNAL `clopen-mcp` bridge. Serves the custom tools
 *     defined via `defineServer()`; handlers execute in-process in the main
 *     Clopen process (no subprocess, no WebSocket bridge), architecturally
 *     identical to how Claude Code uses `createSdkMcpServer()`.
 *
 *   - `/mcp/ext/<slug>` — an EXTERNAL proxy. Clopen connects to a user-installed
 *     third-party server (`backend/mcp/external/proxy.ts`) and re-exposes its
 *     sanitized tools here, so engines never connect to it directly.
 *
 * Both share the session/transport plumbing below; they differ only in the
 * server `handleStreamable` builds per session.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteMcpServer } from './servers/helper';
import { createExternalProxyServer } from '../external/proxy';
import { debug } from '$shared/utils/logger';
import { authQueries } from '$backend/database/queries';
import { hashToken } from '$backend/auth/tokens';
import { getAuthMode } from '$backend/auth/auth-service';
import { isMcpServiceToken } from './service-token';

/** Anything we can `.connect(transport)` — both `McpServer` and low-level `Server`. */
interface ConnectableServer {
	connect(transport: WebStandardStreamableHTTPServerTransport): Promise<void>;
}

/** A built server plus optional teardown (external proxies close their upstream client). */
interface BuiltServer {
	server: ConnectableServer;
	close?: () => Promise<void>;
}

// Lazy imports to avoid circular dependencies at module load time
let _allServers: Parameters<typeof createRemoteMcpServer>[0] | null = null;
let _enabledConfig: Parameters<typeof createRemoteMcpServer>[1] | null = null;

async function getServerDeps() {
	if (!_allServers || !_enabledConfig) {
		const { allServers } = await import('./servers/index');
		const { mcpServersConfig } = await import('./config');
		_allServers = allServers;
		_enabledConfig = mcpServersConfig;
	}
	return { allServers: _allServers, enabledConfig: _enabledConfig };
}

// ============================================================================
// Session Management
// ============================================================================

/** Active transports keyed by MCP session ID */
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

/**
 * Per-session teardown for the MCP server bound to it. Internal sessions have
 * no upstream to release (`() => {}`); external-proxy sessions close their
 * upstream client (and any stdio subprocess) here.
 */
const sessionCleanups = new Map<string, () => Promise<void>>();

/** Forget a session and run its teardown. Idempotent. */
function disposeSession(sessionId: string): void {
	transports.delete(sessionId);
	const cleanup = sessionCleanups.get(sessionId);
	sessionCleanups.delete(sessionId);
	cleanup?.().catch(error => debug.warn('mcp', `Error tearing down MCP session ${sessionId}:`, error));
}

/**
 * Validate authentication token from request headers.
 * Pure validator - does NOT create new sessions.
 * Returns user info if valid, null otherwise.
 */
function validateAuthToken(request: Request): { userId: string; role: string } | null {
	const authHeader = request.headers.get('authorization');
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
		return null;
	}

	const token = authHeader.substring(7).trim();
	if (!token) {
		return null;
	}

	// Internal bridge credential: the non-Claude engines authenticate to this
	// loopback endpoint with the process-scoped service token, not a user
	// session. Accept it regardless of auth mode — it never leaves the host.
	if (isMcpServiceToken(token)) {
		return { userId: 'mcp-service', role: 'admin' };
	}

	const tokenHash = hashToken(token);

	// Try session token first
	const session = authQueries.getSessionByTokenHash(tokenHash);
	if (session) {
		if (new Date(session.expires_at) < new Date()) {
			return null; // Expired
		}
		const user = authQueries.getUserById(session.user_id);
		if (!user) {
			return null;
		}
		return { userId: user.id, role: user.role };
	}

	// Try PAT (Personal Access Token)
	const user = authQueries.getUserByPatHash(tokenHash);
	if (user) {
		return { userId: user.id, role: user.role };
	}

	return null;
}

/**
 * Check if authentication is required based on auth mode.
 */
function isAuthRequired(): boolean {
	return getAuthMode() !== 'none';
}

/** JSON-RPC error helper for the bridge endpoints. */
function jsonRpcError(status: number, code: number, message: string, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

/**
 * Shared Streamable-HTTP request core for every bridge endpoint.
 *
 * Follows the Streamable HTTP transport protocol:
 * - POST without session: initialization → build a fresh server via `makeServer`
 * - POST/GET/DELETE with session: route to the existing transport
 *
 * `makeServer` is the only thing that differs between endpoints: the internal
 * `/mcp` builds the in-process `clopen-mcp` tool server; `/mcp/ext/<slug>`
 * builds an external proxy. A `makeServer` rejection (e.g. an upstream that
 * won't connect) is returned as a JSON-RPC error for THAT endpoint only — it
 * never affects other servers or sessions.
 */
async function handleStreamable(
	request: Request,
	label: string,
	makeServer: () => Promise<BuiltServer>
): Promise<Response> {
	// Authentication check (skip if authMode is 'none')
	if (isAuthRequired()) {
		const auth = validateAuthToken(request);
		if (!auth) {
			return jsonRpcError(401, -32001, 'Unauthorized: Valid Bearer token required', {
				'WWW-Authenticate': 'Bearer realm="MCP Server"',
			});
		}
	}

	const sessionId = request.headers.get('mcp-session-id');

	// Existing session — route to its transport
	if (sessionId && transports.has(sessionId)) {
		return transports.get(sessionId)!.handleRequest(request);
	}

	// New initialization request — create transport + MCP server
	if (request.method === 'POST') {
		const body = await request.json();

		if (isInitializeRequest(body)) {
			let built: BuiltServer;
			try {
				built = await makeServer();
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Failed to start MCP server';
				debug.warn('mcp', `🌐 ${label}: server init failed — ${message}`);
				return jsonRpcError(502, -32000, `MCP server unavailable: ${message}`);
			}

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: (sid) => {
					transports.set(sid, transport);
					if (built.close) sessionCleanups.set(sid, built.close);
					debug.log('mcp', `🌐 ${label} session initialized: ${sid}`);
				},
				onsessionclosed: (sid) => {
					disposeSession(sid);
					debug.log('mcp', `🌐 ${label} session closed: ${sid}`);
				},
			});

			transport.onclose = () => {
				if (transport.sessionId) disposeSession(transport.sessionId);
			};

			await built.server.connect(transport);

			// Handle the initialization request with pre-parsed body
			return transport.handleRequest(request, { parsedBody: body });
		}
	}

	// Invalid request
	return jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');
}

/**
 * Handle an incoming request to the INTERNAL `clopen-mcp` bridge (`/mcp`).
 * Serves the in-process custom tools defined via `defineServer()`.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
	return handleStreamable(request, 'Remote MCP', async () => {
		const { allServers, enabledConfig } = await getServerDeps();
		return { server: createRemoteMcpServer(allServers, enabledConfig) };
	});
}

/**
 * Handle an incoming request to an EXTERNAL proxy bridge
 * (`/mcp/ext/<slug>`). Clopen connects to the upstream third-party server and
 * re-exposes its (sanitized) tools, so engines never connect to it directly.
 */
export async function handleExternalMcpRequest(request: Request, slug: string): Promise<Response> {
	return handleStreamable(request, `External MCP (${slug})`, () => createExternalProxyServer(slug));
}

/**
 * Close all active MCP sessions and transports.
 * Called during graceful server shutdown.
 */
export async function closeMcpServer(): Promise<void> {
	for (const [sessionId, transport] of transports) {
		try {
			await transport.close();
			debug.log('mcp', `🌐 Remote MCP transport closed: ${sessionId}`);
		} catch (error) {
			debug.error('mcp', `Error closing MCP transport ${sessionId}:`, error);
		}
	}
	// Release any upstream proxy clients (and their stdio subprocesses).
	for (const [sessionId, cleanup] of sessionCleanups) {
		try { await cleanup(); }
		catch (error) { debug.error('mcp', `Error closing upstream for MCP session ${sessionId}:`, error); }
	}
	transports.clear();
	sessionCleanups.clear();
	debug.log('mcp', '🌐 All remote MCP sessions closed');
}
