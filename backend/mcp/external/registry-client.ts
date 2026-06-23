/**
 * Official MCP Registry client.
 *
 * Browses servers from registry.modelcontextprotocol.io and normalises each
 * into a single installable `CatalogServer`. The registry exposes a server as
 * a set of `packages` (stdio runtimes such as npx/uvx/docker) and/or `remotes`
 * (HTTP/SSE URLs). We pick a preferred target and flatten it into the install
 * config Clopen stores.
 *
 * Docs: https://registry.modelcontextprotocol.io/docs#/operations/list-servers-v0.1
 */

import { debug } from '$shared/utils/logger';
import type { McpTransport } from '$backend/database/queries';
import { slugifyRegistryName } from '../shared/constants';
import type { CatalogServer, CatalogEnvVar, CatalogPage } from './types';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Registry response shapes (only the subset we consume)
// ---------------------------------------------------------------------------

interface RegistryArgument {
	type?: 'positional' | 'named';
	name?: string;
	value?: string;
	default?: string;
}

interface RegistryEnvVar {
	name: string;
	description?: string;
	isRequired?: boolean;
	isSecret?: boolean;
	default?: string;
}

interface RegistryPackage {
	registryType?: string;
	identifier?: string;
	version?: string;
	runtimeHint?: string;
	transport?: { type?: string };
	runtimeArguments?: RegistryArgument[];
	packageArguments?: RegistryArgument[];
	environmentVariables?: RegistryEnvVar[];
}

interface RegistryRemote {
	type?: string;
	url: string;
	/** Header inputs the server requires (auth tokens, API keys). */
	headers?: RegistryEnvVar[];
}

interface RegistryServer {
	name: string;
	title?: string;
	description?: string;
	version?: string;
	packages?: RegistryPackage[];
	remotes?: RegistryRemote[];
}

interface RegistryListResponse {
	servers: Array<{ server: RegistryServer }>;
	metadata?: { nextCursor?: string | null; count?: number };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Map a registry package registryType to its default CLI runtime. */
function inferRuntime(registryType: string | undefined): string | null {
	switch (registryType) {
		case 'npm': return 'npx';
		case 'pypi': return 'uvx';
		case 'oci': return 'docker';
		case 'nuget': return 'dnx';
		default: return null;
	}
}

/** Flatten a single registry argument into zero or more CLI tokens. */
function argTokens(arg: RegistryArgument): string[] {
	const tokens: string[] = [];
	if (arg.type === 'named' && arg.name) tokens.push(arg.name);
	const val = arg.value ?? arg.default;
	if (val != null && val !== '') tokens.push(String(val));
	return tokens;
}

function mapEnvVars(vars: RegistryEnvVar[] | undefined): CatalogEnvVar[] {
	return (vars ?? []).map(v => ({
		name: v.name,
		description: v.description,
		isRequired: Boolean(v.isRequired),
		isSecret: Boolean(v.isSecret),
		default: v.default
	}));
}

/** Build a stdio command + args from a registry package. Returns null if unsupported. */
function resolveStdioPackage(pkg: RegistryPackage): { command: string; args: string[] } | null {
	const command = pkg.runtimeHint || inferRuntime(pkg.registryType);
	if (!command || !pkg.identifier) return null;

	const args: string[] = [];
	const runtimeArgs = pkg.runtimeArguments ?? [];
	// `npx` prompts before fetching an uncached package; `-y` keeps the
	// non-interactive spawn (health probe + engine) from stalling on that prompt.
	// Skip if the registry already supplies a confirm flag.
	if (/(^|\/)npx$/.test(command) && !runtimeArgs.some(a => a.name === '-y' || a.name === '--yes')) {
		args.push('-y');
	}
	for (const a of runtimeArgs) args.push(...argTokens(a));

	// Package identifier token (with version for npm-style registries).
	const identifier = pkg.version && pkg.registryType === 'npm'
		? `${pkg.identifier}@${pkg.version}`
		: pkg.identifier;
	args.push(identifier);

	for (const a of pkg.packageArguments ?? []) args.push(...argTokens(a));
	return { command, args };
}

/** Normalise one registry server into a single installable target, or null. */
export function mapRegistryServer(server: RegistryServer): CatalogServer | null {
	const base = {
		registryName: server.name,
		slug: slugifyRegistryName(server.name),
		title: server.title || server.name,
		description: server.description || '',
		version: server.version || ''
	};

	// Prefer a self-contained stdio package; fall back to a remote URL.
	const pkg = (server.packages ?? []).find(p => (p.transport?.type ?? 'stdio') === 'stdio') ?? server.packages?.[0];
	if (pkg) {
		const stdio = resolveStdioPackage(pkg);
		if (stdio) {
			return {
				...base,
				transport: 'stdio' as McpTransport,
				command: stdio.command,
				args: stdio.args,
				envVars: mapEnvVars(pkg.environmentVariables),
				headerVars: [],
				packageHint: pkg.registryType && pkg.identifier ? `${pkg.registryType}:${pkg.identifier}` : undefined
			};
		}
	}

	const remote = server.remotes?.[0];
	if (remote?.url) {
		return {
			...base,
			transport: (remote.type === 'sse' ? 'sse' : 'http') as McpTransport,
			url: remote.url,
			envVars: [],
			// Auth tokens / API keys the remote server requires as HTTP headers.
			headerVars: mapEnvVars(remote.headers)
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List registry servers, normalised. Supports search and cursor pagination.
 * Servers with no installable target are dropped.
 */
export async function listRegistryServers(opts: { search?: string; cursor?: string; limit?: number } = {}): Promise<CatalogPage> {
	const params = new URLSearchParams();
	if (opts.search) params.set('search', opts.search);
	if (opts.cursor) params.set('cursor', opts.cursor);
	params.set('limit', String(opts.limit ?? 30));
	// Only the latest version of each server — the registry otherwise returns
	// one entry per published version (e.g. 1.0.0 AND 1.0.1).
	params.set('version', 'latest');

	const url = `${REGISTRY_BASE}?${params.toString()}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: 'application/json' }
		});
		if (!res.ok) {
			throw new Error(`Registry responded ${res.status} ${res.statusText}`);
		}
		const data = (await res.json()) as RegistryListResponse;
		const servers = (data.servers ?? [])
			.map(entry => mapRegistryServer(entry.server))
			.filter((s): s is CatalogServer => s !== null);

		debug.log('mcp', `🛰️ Registry catalog page: ${servers.length} installable servers`);
		return { servers, nextCursor: data.metadata?.nextCursor ?? null };
	} catch (error) {
		// The registry is intermittently slow; surface a clean, retryable message
		// instead of the raw "The operation was aborted." DOMException.
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			debug.warn('mcp', `MCP registry request timed out after ${FETCH_TIMEOUT_MS}ms`);
			throw new Error('The MCP registry took too long to respond. Please try again.');
		}
		debug.error('mcp', 'Failed to fetch MCP registry:', error);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
