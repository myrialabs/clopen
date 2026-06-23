/**
 * Manual MCP config parser.
 *
 * Users install MCP servers from product docs (Notion, Linear, Stitch, …) that
 * publish a JSON snippet for ONE specific host — Claude Desktop, Cursor, VS
 * Code, Windsurf, OpenCode — never for Clopen. There is no cross-tool standard,
 * so this normaliser is deliberately tolerant: it accepts every common dialect
 * and flattens each server into the shape Clopen's `mcp:install` stores. The UI
 * shows the result for review before anything is persisted, so a best-effort
 * guess (with `warnings`) beats rejecting an unfamiliar shape.
 *
 * Dialects handled:
 *   - `mcpServers` map      — Claude Desktop / Cursor / Windsurf / Antigravity
 *   - `servers` map         — VS Code (`type` field; `${input:…}` placeholders)
 *   - `mcp` map             — OpenCode (`type: local|remote`, `command` array,
 *                             `environment` instead of `env`)
 *   - a bare `name → config` map with no wrapper
 *   - a single server config object with no wrapper
 *
 * The input may be JSONC (comments + trailing commas), which VS Code emits.
 */

import { slugifyRegistryName } from '../shared/constants';
import type { McpTransport } from '$backend/database/queries';

/**
 * One env/header input flattened from a parsed server. `value` is the literal
 * the snippet carried; `isPlaceholder` marks the obvious "fill me in" tokens
 * (`<your-token>`, `${input:…}`, `YOUR_API_KEY`, blank) so the UI can require
 * them before install instead of persisting a dud credential.
 */
export interface ParsedField {
	name: string;
	kind: 'env' | 'header';
	value: string;
	isPlaceholder: boolean;
}

/** A single server normalised from pasted JSON, ready for review + install. */
export interface ParsedMcpServer {
	/** Suggested display name (the map key, or derived for an unwrapped object). */
	name: string;
	/** Slug derived from the name; the backend re-slugifies and de-dupes on install. */
	slug: string;
	transport: McpTransport;
	command?: string;
	args: string[];
	url?: string;
	fields: ParsedField[];
	/** Non-fatal notes surfaced in the preview (guessed transport, missing command, …). */
	warnings: string[];
}

export interface ParseResult {
	servers: ParsedMcpServer[];
	/** Fatal problems (invalid JSON, nothing server-shaped) — empty on success. */
	errors: string[];
}

// ---------------------------------------------------------------------------
// JSONC tolerance
// ---------------------------------------------------------------------------

/**
 * Strip `//` and block comments from a JSONC string without touching comment-
 * like sequences inside string literals. Used as a fallback when strict
 * `JSON.parse` fails — VS Code's `mcp.json` is JSONC.
 */
function stripJsonComments(input: string): string {
	let out = '';
	let inStr = false;
	let strCh = '';
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		const n = input[i + 1];
		if (inLine) {
			if (c === '\n') { inLine = false; out += c; }
			continue;
		}
		if (inBlock) {
			if (c === '*' && n === '/') { inBlock = false; i++; }
			continue;
		}
		if (inStr) {
			out += c;
			if (c === '\\') { out += input[i + 1] ?? ''; i++; continue; }
			if (c === strCh) inStr = false;
			continue;
		}
		if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; continue; }
		if (c === '/' && n === '/') { inLine = true; i++; continue; }
		if (c === '/' && n === '*') { inBlock = true; i++; continue; }
		out += c;
	}
	return out;
}

/** Parse JSON, retrying with comments + trailing commas stripped (JSONC). */
function relaxedParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		const cleaned = stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1');
		return JSON.parse(cleaned);
	}
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrUndef(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Coerce an unknown into a `Record<string,string>`, dropping non-string values. */
function recordOfStrings(v: unknown): Record<string, string> {
	if (!isPlainObject(v)) return {};
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === 'string') out[k] = val;
		else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
	}
	return out;
}

/**
 * True for values that are clearly stand-ins the user must replace — so the UI
 * marks them required instead of installing a server that fails at connect time.
 */
function isPlaceholder(value: string): boolean {
	const s = value.trim();
	if (!s) return true;
	if (/^<.*>$/.test(s)) return true; // <your-token>
	if (/\$\{.*\}/.test(s)) return true; // ${input:api-key}, ${API_KEY}
	if (/^(your|my)[_-]/i.test(s)) return true; // your_api_key
	if (/_here$/i.test(s)) return true; // TOKEN_HERE
	if (/^(x{3,}|changeme|replace[_-]?me|insert[_-].*|example|placeholder|todo|none)$/i.test(s)) return true;
	return false;
}

function fieldsFrom(map: Record<string, string>, kind: 'env' | 'header'): ParsedField[] {
	return Object.entries(map).map(([name, value]) => ({
		name,
		kind,
		value: isPlaceholder(value) ? '' : value,
		isPlaceholder: isPlaceholder(value)
	}));
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Map an explicit `type` token (across dialects) to a Clopen transport. */
function transportFromType(typeRaw: string): McpTransport | undefined {
	switch (typeRaw) {
		case 'stdio':
		case 'local':
			return 'stdio';
		case 'sse':
			return 'sse';
		case 'http':
		case 'https':
		case 'remote':
		case 'streamable-http':
		case 'streamable_http':
		case 'streamablehttp':
			return 'http';
		default:
			return undefined;
	}
}

/** Normalise one raw server config object into a `ParsedMcpServer`, or null. */
function normalizeServer(name: string, raw: unknown): ParsedMcpServer | null {
	if (!isPlainObject(raw)) return null;
	const warnings: string[] = [];

	// command: string (most dialects) or array (OpenCode: ["npx","-y","pkg"]).
	let command: string | undefined;
	let args: string[] = [];
	const rawCommand = raw.command;
	if (Array.isArray(rawCommand)) {
		const parts = rawCommand.filter((x): x is string => typeof x === 'string');
		command = parts[0];
		args = parts.slice(1);
	} else if (typeof rawCommand === 'string') {
		command = rawCommand;
		if (Array.isArray(raw.args)) args = raw.args.filter((x): x is string => typeof x === 'string');
	}

	const url = strOrUndef(raw.url) ?? strOrUndef(raw.serverUrl) ?? strOrUndef(raw.httpUrl);
	const env = { ...recordOfStrings(raw.env), ...recordOfStrings(raw.environment) };
	const headers = recordOfStrings(raw.headers);

	// Transport: explicit `type` wins; otherwise infer from what's present.
	const typeRaw = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
	let transport = typeRaw ? transportFromType(typeRaw) : undefined;
	const transportExplicit = transport !== undefined;
	if (!transport) {
		if (command) transport = 'stdio';
		else if (url) transport = /\/sse(\/|$)/.test(url) ? 'sse' : 'http';
	}
	if (!transport) {
		warnings.push('Could not determine transport — defaulting to local (stdio).');
		transport = 'stdio';
	}

	// Per the agreed default, an ambiguous remote is treated as http; flag it so
	// the user can switch to sse in the preview if the server needs it.
	if (!transportExplicit && transport === 'http' && url) {
		warnings.push('Assumed remote (http). Switch to sse if this server uses Server-Sent Events.');
	}

	if (transport === 'stdio' && !command) {
		warnings.push('No command found for a local server — set one before installing.');
	}
	if (transport !== 'stdio' && !url) {
		warnings.push('No URL found for a remote server — set one before installing.');
	}
	if (Object.values({ ...env, ...headers }).some(v => /\$\{input:/.test(v))) {
		warnings.push('Contains ${input:…} placeholders — fill them in below.');
	}

	const fields = [...fieldsFrom(env, 'env'), ...fieldsFrom(headers, 'header')];
	const cleanName = name.trim() || 'server';
	return {
		name: cleanName,
		slug: slugifyRegistryName(cleanName),
		transport,
		command,
		args,
		url,
		fields,
		warnings
	};
}

/** True when an object looks like a single server config rather than a map of them. */
function looksLikeServerConfig(obj: Record<string, unknown>): boolean {
	return 'command' in obj || 'url' in obj || 'serverUrl' in obj || 'httpUrl' in obj || 'type' in obj;
}

/**
 * Locate the `name → config` map inside a parsed payload, unwrapping the known
 * container keys and tolerating a bare map or a single unwrapped server object.
 */
function findServerMap(obj: Record<string, unknown>): Record<string, unknown> {
	for (const key of ['mcpServers', 'servers', 'mcp'] as const) {
		if (isPlainObject(obj[key])) return obj[key] as Record<string, unknown>;
	}
	// A single unwrapped server object (e.g. the inner block someone copied).
	if (looksLikeServerConfig(obj)) return { server: obj };
	// Otherwise assume the object IS the map (its values are server configs).
	return obj;
}

/**
 * Parse pasted MCP JSON (any common dialect) into normalised servers. Never
 * throws — fatal problems are returned in `errors` for the UI to surface.
 */
export function parseMcpConfig(raw: string): ParseResult {
	if (!raw.trim()) return { servers: [], errors: ['Paste an MCP server JSON config first.'] };

	let parsed: unknown;
	try {
		parsed = relaxedParse(raw);
	} catch (error) {
		return { servers: [], errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'could not parse'}`] };
	}
	if (!isPlainObject(parsed)) {
		return { servers: [], errors: ['Expected a JSON object with one or more MCP servers.'] };
	}

	const map = findServerMap(parsed);
	const servers: ParsedMcpServer[] = [];
	for (const [name, rawCfg] of Object.entries(map)) {
		const server = normalizeServer(name, rawCfg);
		if (server) servers.push(server);
	}

	if (servers.length === 0) {
		return { servers: [], errors: ['No MCP server found. Expected a "mcpServers", "servers", or "mcp" block, or a single server config.'] };
	}
	return { servers, errors: [] };
}
