/**
 * External (user-installed) MCP — shared types.
 *
 * These describe servers sourced from the official MCP registry and stored in
 * the `mcp_servers` table. Distinct from the internal custom-tool servers.
 */

import type { McpTransport } from '$backend/database/queries';

/** An environment variable an external server needs (surfaced from registry). */
export interface CatalogEnvVar {
	name: string;
	description?: string;
	isRequired: boolean;
	isSecret: boolean;
	default?: string;
}

/**
 * A registry server normalised into a single installable target.
 *
 * The registry exposes a server as a set of `packages` (stdio runtimes) and/or
 * `remotes` (HTTP/SSE URLs). We pick one preferred target and flatten it into
 * the install config Clopen stores. `envVars` is what the UI prompts for.
 */
export interface CatalogServer {
	/** Original reverse-DNS registry name, e.g. `io.github.foo/bar`. */
	registryName: string;
	/** Sanitised unique slug; the `<slug>` namespace is derived from it. */
	slug: string;
	title: string;
	description: string;
	version: string;
	transport: McpTransport;
	/** stdio target. */
	command?: string;
	args?: string[];
	/** http/sse target. */
	url?: string;
	/** Env vars the user must/may provide before the server can run (stdio). */
	envVars: CatalogEnvVar[];
	/** HTTP header inputs the remote server requires (auth tokens, API keys). */
	headerVars: CatalogEnvVar[];
	/** Human hint of the underlying package, e.g. `npm:@scope/pkg`. */
	packageHint?: string;
}

/** A page of catalog results plus the registry pagination cursor. */
export interface CatalogPage {
	servers: CatalogServer[];
	nextCursor: string | null;
}

/**
 * A server resolved from a DB row, ready to be turned into per-engine MCP
 * config. JSON columns are parsed; `namespace` is the `<slug>` key.
 */
export interface ResolvedExternalServer {
	id: number;
	slug: string;
	namespace: string;
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string[];
	env: Record<string, string>;
	url: string | null;
	headers: Record<string, string>;
}
