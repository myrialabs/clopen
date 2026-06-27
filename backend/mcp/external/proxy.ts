/**
 * External MCP — in-process proxy through the `/mcp/ext/<slug>` bridge.
 *
 * Instead of pointing each engine straight at a third-party MCP server (stdio
 * subprocess or remote URL), Clopen connects to that server ITSELF as an MCP
 * client and re-exposes its tools through a per-server endpoint on the same
 * Streamable-HTTP bridge the internal `clopen-mcp` tools already use. The
 * engine then talks only to Clopen (loopback + service token).
 *
 * Why proxy at all? Because Clopen owns the upstream client, it can:
 *   1. Read `tools/list` with a RAW JSON-RPC request — bypassing the MCP SDK's
 *      `Client.listTools()` wrapper, which eagerly compiles an Ajv validator
 *      for every tool's `outputSchema`. A single unresolvable `$ref` (e.g.
 *      stitch's `#/$defs/ScreenInstance`) makes that wrapper throw, and the
 *      engine CLIs' `discoverTools` swallow the error and surface ZERO tools —
 *      so a "connected" server silently advertises nothing.
 *   2. Sanitize each tool before re-exposing it: drop the crash-prone
 *      `outputSchema` and strip dangling `$ref`s from `inputSchema`.
 *   3. Inject the centrally-managed OAuth bearer / static API key once, on the
 *      upstream hop — the engine→bridge hop only carries the service token.
 *
 * Net effect: external MCP servers behave identically on EVERY engine, and a
 * server with invalid tool schemas degrades to "valid tools still work"
 * instead of "whole server disappears".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
	ListToolsResultSchema,
	CompatibilityCallToolResultSchema,
	type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { debug } from '$shared/utils/logger';
import { mcpServerQueries } from '$backend/database/queries';
import { resolveServerRow } from './config';
import type { ResolvedExternalServer } from './types';

/** Cap on how long we wait for an upstream server to complete its handshake. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Open an MCP client connection to a single upstream external server (stdio
 * subprocess or remote HTTP/SSE). OAuth/API-key headers come from
 * `resolveServerRow`, which injects the Clopen-managed bearer.
 */
async function connectUpstream(s: ResolvedExternalServer): Promise<Client> {
	const client = new Client({ name: 'clopen-proxy', version: '1.0.0' }, { capabilities: {} });

	if (s.transport === 'stdio') {
		if (!s.command) throw new Error(`External server "${s.slug}" is stdio but has no command`);
		// Merge over the SDK's safe default env (PATH, HOME, …) so `npx`/`uvx`
		// resolve — passing only `s.env` would strip the inherited PATH.
		const transport = new StdioClientTransport({
			command: s.command,
			args: s.args,
			env: { ...getDefaultEnvironment(), ...s.env },
			stderr: 'ignore'
		});
		await client.connect(transport, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS });
		return client;
	}

	if (!s.url) throw new Error(`External server "${s.slug}" is ${s.transport} but has no URL`);
	const url = new URL(s.url);
	const requestInit = Object.keys(s.headers).length > 0 ? { headers: s.headers } : undefined;
	const transport = s.transport === 'sse'
		? new SSEClientTransport(url, { requestInit })
		: new StreamableHTTPClientTransport(url, { requestInit });
	await client.connect(transport, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS });
	return client;
}

/**
 * Strip every `$ref` that points at a `$defs`/`definitions` entry the schema
 * doesn't actually declare. Such dangling refs are what make a downstream
 * Ajv `compile()` throw `MissingRefError`; replacing the offending node with an
 * empty (permissive) schema keeps the rest of the shape intact and validatable.
 *
 * Best-effort and shallow on cost: walks the tree once, mutating a deep clone.
 */
function repairSchema<T>(schema: T): T {
	if (schema == null || typeof schema !== 'object') return schema;
	const root = schema as Record<string, unknown>;

	const defs = new Set<string>();
	for (const key of ['$defs', 'definitions'] as const) {
		const bucket = root[key];
		if (bucket && typeof bucket === 'object') {
			for (const name of Object.keys(bucket as Record<string, unknown>)) defs.add(`${key}/${name}`);
		}
	}

	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === 'object') {
			const obj = node as Record<string, unknown>;
			const ref = obj.$ref;
			if (typeof ref === 'string' && ref.startsWith('#/')) {
				const target = ref.slice(2); // strip "#/"
				if (!defs.has(target)) {
					// Dangling local ref → drop it, leaving any sibling keywords.
					const { $ref, ...rest } = obj;
					void $ref;
					return walk(rest);
				}
			}
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
			return out;
		}
		return node;
	};

	return walk(root) as T;
}

/**
 * Re-expose an upstream tool to engines: keep its identity + input schema,
 * repair dangling `$ref`s, and DROP `outputSchema` entirely. `outputSchema` is
 * the field whose unresolvable `$ref`s crash the engines' eager Ajv
 * compilation, and non-Claude engines don't rely on it — dropping it is the
 * safest way to make every server's tools usable.
 */
function sanitizeTool(t: Tool): Tool {
	const { outputSchema: _drop, inputSchema, ...rest } = t;
	void _drop;
	return {
		...rest,
		inputSchema: repairSchema(inputSchema ?? { type: 'object' as const })
	} as Tool;
}

/** Read every page of an upstream `tools/list` via RAW requests (no Ajv caching). */
async function listAllToolsRaw(client: Client): Promise<Tool[]> {
	const tools: Tool[] = [];
	let cursor: string | undefined;
	do {
		const res = await client.request(
			{ method: 'tools/list', params: cursor ? { cursor } : {} },
			ListToolsResultSchema
		);
		tools.push(...res.tools);
		cursor = res.nextCursor;
	} while (cursor);
	return tools;
}

/** A bound proxy server plus the cleanup that tears down its upstream client. */
export interface ExternalProxy {
	server: Server;
	close: () => Promise<void>;
}

/**
 * Build a low-level MCP `Server` that proxies one external server identified by
 * `slug`. `tools/list` returns the upstream's sanitized tools; `tools/call`
 * forwards verbatim. Throws if the slug isn't an enabled external server or the
 * upstream handshake fails (the caller surfaces this as a per-server failure,
 * never taking down the whole bridge).
 */
export async function createExternalProxyServer(slug: string): Promise<ExternalProxy> {
	const row = mcpServerQueries.getBySlug(slug);
	if (!row || row.source === 'internal') throw new Error(`Unknown external MCP server: ${slug}`);
	if (row.is_enabled !== 1) throw new Error(`External MCP server is disabled: ${slug}`);

	const resolved = resolveServerRow(row);
	const client = await connectUpstream(resolved);

	const server = new Server(
		{ name: `clopen-ext-${slug}`, version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools = (await listAllToolsRaw(client)).map(sanitizeTool);
		debug.log('mcp', `🔌 Proxy ${slug}: serving ${tools.length} tool(s)`);
		return { tools };
	});

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		// Forward verbatim. CompatibilityCallToolResultSchema tolerates both the
		// modern and 2024-10-07 result shapes; we never cached an output
		// validator (we bypass listTools), so no schema check runs here.
		return await client.request(
			{ method: 'tools/call', params: req.params },
			CompatibilityCallToolResultSchema
		);
	});

	const close = async () => {
		try { await client.close(); }
		catch (error) { debug.warn('mcp', `Proxy ${slug}: error closing upstream client:`, error); }
	};

	return { server, close };
}
