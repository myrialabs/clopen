/**
 * External MCP — connection health probe.
 *
 * Performs the MCP handshake (`initialize` → `tools/list`) against a stored
 * server using its own config, and classifies the outcome. This is what makes
 * a broken external server VISIBLE in Settings instead of silently exposing
 * zero tools to an engine — the failure mode that hid `com-notion-mcp`
 * (OAuth 401) and `ai-trendsmcp-google-trends` (missing API key).
 *
 * The probe is engine-agnostic: it talks to the remote URL directly with the
 * stored headers. It therefore reflects whether the server is reachable and
 * whether the *stored* credential is sufficient. For OAuth servers (no static
 * credential) it reports `needs_auth` — the engine still authenticates via its
 * own per-engine token store, but the user gets a clear, actionable signal.
 */

import { debug } from '$shared/utils/logger';
import type { ResolvedExternalServer } from './types';

/**
 * Classified outcome of a connection probe.
 *  - `needs_auth`   : OAuth sign-in required (offer Authenticate)
 *  - `needs_config` : a static credential / API key is missing (offer Configure)
 */
export type McpHealthState = 'ok' | 'needs_auth' | 'needs_config' | 'unreachable' | 'error' | 'local';

export interface McpHealth {
	state: McpHealthState;
	/** Tool count when `ok`. */
	toolCount?: number;
	/** Human-readable detail for non-ok states. */
	message?: string;
}

const PROBE_TIMEOUT_MS = 12_000;
const STDIO_PROBE_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-03-26';

/** Patterns in an error payload that indicate a missing/invalid credential. */
const AUTH_HINT = /\b(api[\s-]?key|unauthor|forbidden|token|auth|sign[\s-]?in|login|credential)\b/i;

interface JsonRpcResponse {
	result?: {
		tools?: unknown[];
		isError?: boolean;
		content?: Array<{ type?: string; text?: string }>;
	};
	error?: { message?: string };
}

/**
 * Read a streamable-HTTP MCP response body, which may be either plain JSON or
 * an SSE stream (`text/event-stream`). Returns the first JSON-RPC object found.
 */
async function readRpc(res: Response): Promise<JsonRpcResponse | null> {
	const text = await res.text();
	const trimmed = text.trim();
	if (!trimmed) return null;
	// Plain JSON.
	if (trimmed.startsWith('{')) {
		try { return JSON.parse(trimmed) as JsonRpcResponse; } catch { /* fall through */ }
	}
	// SSE: pick the last `data:` line carrying a JSON-RPC object.
	for (const line of trimmed.split('\n').reverse()) {
		const t = line.trim();
		if (t.startsWith('data:')) {
			const payload = t.slice(5).trim();
			try { return JSON.parse(payload) as JsonRpcResponse; } catch { /* keep scanning */ }
		}
	}
	return null;
}

function rpcBody(method: string, id?: number, params?: unknown): string {
	return JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, ...(params != null ? { params } : {}) });
}

/**
 * A 401/403 with a `Bearer` challenge is an OAuth server → offer sign-in.
 * Otherwise the server wants a static credential we don't have → offer Configure.
 */
function classifyUnauthorized(res: Response): McpHealth {
	const challenge = res.headers.get('www-authenticate') ?? '';
	if (/bearer/i.test(challenge)) {
		return { state: 'needs_auth', message: 'OAuth sign-in required' };
	}
	return { state: 'needs_config', message: 'A credential (API key / token) is required' };
}

/** Cap on captured stderr so a chatty subprocess can't balloon memory. */
const STDERR_CAP = 4000;

/** Drain a subprocess's stderr into a bounded string (best-effort). */
async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	try {
		while (text.length < STDERR_CAP) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} catch { /* stream closed/cancelled */ } finally {
		reader.cancel().catch(() => undefined);
	}
	return text;
}

/** Condense captured stderr into a short, single-line diagnostic. */
function stderrTail(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Spawn a stdio server and run the same handshake over its stdin/stdout
 * (newline-delimited JSON-RPC) so "local" servers report a real connection
 * status, consistent with remote ones. The subprocess is always killed.
 */
async function probeStdio(s: ResolvedExternalServer): Promise<McpHealth> {
	if (!s.command) return { state: 'error', message: 'No command configured' };

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([s.command, ...s.args], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...s.env }
		});
	} catch (error) {
		return { state: 'unreachable', message: error instanceof Error ? error.message : 'Failed to start command' };
	}

	// Capture stderr concurrently so a process that prints usage/errors and then
	// exits (e.g. a CLI that needs a `mcp` subcommand to actually start the
	// server) yields an actionable message instead of a misleading timeout.
	const stderrPromise = drainStderr(proc.stderr as unknown as ReadableStream<Uint8Array>);

	try {
		const stdin = proc.stdin as unknown as { write(data: Uint8Array): number; flush?(): Promise<number> | number };
		const stdout = proc.stdout as unknown as ReadableStream<Uint8Array>;
		const write = (obj: unknown) => stdin.write(new TextEncoder().encode(`${JSON.stringify(obj)}\n`));
		write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'clopen-probe', version: '1.0.0' } } });
		write({ jsonrpc: '2.0', method: 'notifications/initialized' });
		write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		await stdin.flush?.();

		const rpc = await readStdoutForId(stdout, 2, STDIO_PROBE_TIMEOUT_MS);
		if (rpc) {
			if (Array.isArray(rpc.result?.tools)) return { state: 'ok', toolCount: rpc.result.tools.length };
			const detail = rpc.error?.message ?? 'Server did not return a tool list';
			return AUTH_HINT.test(detail) ? { state: 'needs_config', message: detail } : { state: 'error', message: detail };
		}

		// No JSON-RPC reply. Distinguish a process that already exited (a real,
		// reportable error — wrong command, missing subcommand, crash) from one
		// that's still alive but silent (a genuine timeout).
		const exitCode = await Promise.race([
			proc.exited,
			new Promise<number | null>(resolve => setTimeout(() => resolve(null), 250))
		]);
		if (exitCode !== null) {
			const tail = stderrTail(await Promise.race([
				stderrPromise,
				new Promise<string>(resolve => setTimeout(() => resolve(''), 200))
			]));
			const detail = tail
				? `Process exited (code ${exitCode}): ${tail}`
				: `Process exited (code ${exitCode}) before responding`;
			return AUTH_HINT.test(detail) ? { state: 'needs_config', message: detail } : { state: 'error', message: detail };
		}
		return { state: 'unreachable', message: `No response within ${STDIO_PROBE_TIMEOUT_MS / 1000}s` };
	} catch (error) {
		return { state: 'error', message: error instanceof Error ? error.message : 'Probe failed' };
	} finally {
		proc.kill();
	}
}

/** Read newline-delimited JSON-RPC from a stream until the response `id` arrives. */
async function readStdoutForId(stream: ReadableStream<Uint8Array>, id: number, timeoutMs: number): Promise<JsonRpcResponse | null> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), remaining))
			]);
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as JsonRpcResponse & { id?: number };
					if (msg.id === id) return msg;
				} catch { /* ignore non-JSON log lines */ }
			}
		}
		return null;
	} finally {
		// cancel() (not releaseLock) settles any still-pending read() so this
		// never throws on an outstanding request.
		reader.cancel().catch(() => undefined);
	}
}

/**
 * Probe a single resolved server. Remote servers do a network handshake; stdio
 * servers are spawned and handshaken over stdio so every server reports a real
 * connection status.
 */
export async function probeServer(s: ResolvedExternalServer): Promise<McpHealth> {
	if (s.transport === 'stdio') return probeStdio(s);
	if (!s.url) return { state: 'error', message: 'No URL configured' };

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const baseHeaders: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		...s.headers
	};

	try {
		// 1. initialize
		const initRes = await fetch(s.url, {
			method: 'POST',
			headers: baseHeaders,
			signal: controller.signal,
			body: rpcBody('initialize', 1, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'clopen-probe', version: '1.0.0' }
			})
		});

		if (initRes.status === 401 || initRes.status === 403) {
			return classifyUnauthorized(initRes);
		}
		if (!initRes.ok) {
			return { state: 'error', message: `Server responded ${initRes.status} ${initRes.statusText}` };
		}

		const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
		await readRpc(initRes); // drain
		const sessionHeaders = sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders;

		// 2. initialized notification (best-effort; some servers require it)
		await fetch(s.url, {
			method: 'POST',
			headers: sessionHeaders,
			signal: controller.signal,
			body: rpcBody('notifications/initialized')
		}).catch(() => undefined);

		// 3. tools/list
		const listRes = await fetch(s.url, {
			method: 'POST',
			headers: sessionHeaders,
			signal: controller.signal,
			body: rpcBody('tools/list', 2)
		});

		if (listRes.status === 401 || listRes.status === 403) {
			return classifyUnauthorized(listRes);
		}
		if (!listRes.ok) {
			return { state: 'error', message: `Server responded ${listRes.status} ${listRes.statusText}` };
		}

		const rpc = await readRpc(listRes);
		if (!rpc) return { state: 'error', message: 'Server returned an unreadable response' };

		// A proper tools/list returns `result.tools`. Servers that gate listing
		// behind a credential (e.g. trendsmcp) instead return an error result
		// such as "No API key …" — surface that as needs_auth so the user knows
		// to add the credential rather than seeing a generic failure.
		if (Array.isArray(rpc.result?.tools)) {
			return { state: 'ok', toolCount: rpc.result.tools.length };
		}

		const detail = rpc.error?.message
			?? rpc.result?.content?.map(c => c.text).filter(Boolean).join(' ')
			?? 'Server did not return a tool list';
		// Listing gated behind a credential (e.g. trendsmcp "No API key …") — the
		// server is reachable, so this is a missing static credential, not OAuth.
		if (AUTH_HINT.test(detail)) {
			return { state: 'needs_config', message: detail };
		}
		return { state: 'error', message: detail };
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return { state: 'unreachable', message: `No response within ${PROBE_TIMEOUT_MS / 1000}s` };
		}
		debug.warn('mcp', `Probe failed for ${s.slug}:`, error);
		return { state: 'unreachable', message: error instanceof Error ? error.message : 'Could not reach server' };
	} finally {
		clearTimeout(timeout);
	}
}
