/**
 * External MCP Server Queries
 *
 * CRUD for user-installed (external) MCP servers — the servers managed from
 * Settings → MCP, sourced from the official MCP registry. This is distinct
 * from the INTERNAL custom-tool servers in `backend/mcp/internal/servers/`,
 * which are defined in code and not stored in the DB.
 *
 * Conventions:
 *   - `slug`     : unique machine id, used to derive the `<slug>` MCP
 *                  namespace. Only `[a-z0-9-]`.
 *   - `transport`: 'stdio' | 'http' | 'sse'.
 *   - `args`/`env`/`headers` are stored as JSON strings.
 */

import { getDatabase } from '../index';

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpSource = 'registry' | 'custom' | 'internal';

/**
 * A single configurable field, captured from the registry catalog at install
 * time so the "Configure" UI can render the same labelled fields it showed at
 * install. Purely UI metadata — engines read the actual values from
 * `env`/`headers`, never from here. `kind` decides whether the value lands in
 * the env map (stdio) or the headers map (remote auth).
 */
export interface McpConfigField {
	name: string;
	kind: 'env' | 'header';
	description?: string;
	isRequired: boolean;
	isSecret: boolean;
}

/** Raw DB row. */
export interface McpServerRow {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	registry_name: string | null;
	version: string | null;
	transport: McpTransport;
	command: string | null;
	args: string;
	env: string;
	url: string | null;
	headers: string;
	config_schema: string;
	/** JSON OAuth state Clopen manages (registration + tokens), or null. */
	oauth: string | null;
	source: McpSource;
	is_enabled: number;
	created_at: string;
}

export interface McpServerInput {
	slug: string;
	name: string;
	description?: string | null;
	registryName?: string | null;
	version?: string | null;
	transport: McpTransport;
	command?: string | null;
	args?: string[];
	env?: Record<string, string>;
	url?: string | null;
	headers?: Record<string, string>;
	configSchema?: McpConfigField[];
	source?: McpSource;
}

export const mcpServerQueries = {
	getAll(): McpServerRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM mcp_servers ORDER BY created_at ASC`).all() as McpServerRow[];
	},

	getEnabled(): McpServerRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM mcp_servers WHERE is_enabled = 1 ORDER BY created_at ASC`).all() as McpServerRow[];
	},

	getById(id: number): McpServerRow | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | null;
	},

	getBySlug(slug: string): McpServerRow | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM mcp_servers WHERE slug = ?`).get(slug) as McpServerRow | null;
	},

	getBySource(source: McpSource): McpServerRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM mcp_servers WHERE source = ? ORDER BY created_at ASC`).all(source) as McpServerRow[];
	},

	insert(input: McpServerInput): McpServerRow {
		const db = getDatabase();
		const result = db.prepare(
			`INSERT INTO mcp_servers
				(slug, name, description, registry_name, version, transport, command, args, env, url, headers, config_schema, source)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description ?? null,
			input.registryName ?? null,
			input.version ?? null,
			input.transport,
			input.command ?? null,
			JSON.stringify(input.args ?? []),
			JSON.stringify(input.env ?? {}),
			input.url ?? null,
			JSON.stringify(input.headers ?? {}),
			JSON.stringify(input.configSchema ?? []),
			input.source ?? 'registry'
		) as { lastInsertRowid: number | bigint };
		const id = Number(result.lastInsertRowid);
		return this.getById(id)!;
	},

	setEnabled(id: number, enabled: boolean): void {
		const db = getDatabase();
		db.prepare(`UPDATE mcp_servers SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	/** Update the stored env (e.g. user-provided API keys) for a server. */
	updateEnv(id: number, env: Record<string, string>): void {
		const db = getDatabase();
		db.prepare(`UPDATE mcp_servers SET env = ? WHERE id = ?`).run(JSON.stringify(env), id);
	},

	/** Update both env (stdio) and headers (remote auth) for a server. */
	updateConfig(id: number, env: Record<string, string>, headers: Record<string, string>): void {
		const db = getDatabase();
		db.prepare(`UPDATE mcp_servers SET env = ?, headers = ? WHERE id = ?`).run(
			JSON.stringify(env),
			JSON.stringify(headers),
			id
		);
	},

	/**
	 * Update a stdio server's command + args. Lets users repair incomplete
	 * registry metadata (e.g. a CLI that needs a `mcp` subcommand to start) that
	 * would otherwise leave the server permanently unreachable.
	 */
	updateCommand(id: number, command: string, args: string[]): void {
		const db = getDatabase();
		db.prepare(`UPDATE mcp_servers SET command = ?, args = ? WHERE id = ?`).run(
			command,
			JSON.stringify(args),
			id
		);
	},

	/** Store (or clear with null) the managed OAuth state JSON for a server. */
	setOAuth(id: number, oauth: string | null): void {
		const db = getDatabase();
		db.prepare(`UPDATE mcp_servers SET oauth = ? WHERE id = ?`).run(oauth, id);
	},

	remove(id: number): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
	},

	/**
	 * Insert or refresh an INTERNAL (code-defined) server row.
	 *
	 * Internal servers are defined in `backend/mcp/internal/servers/` — the DB
	 * row is only a mirror used for listing + the enable/disable toggle. On
	 * update we refresh the display metadata (title/description/version) but
	 * PRESERVE `is_enabled` so the user's toggle survives restarts. New rows
	 * default to enabled and `stdio` transport (they run in-process / via the
	 * `/mcp` bridge, surfaced to the user as "local (stdio)").
	 */
	upsertInternal(input: { slug: string; name: string; description: string | null; version: string }): McpServerRow {
		const db = getDatabase();
		const existing = this.getBySlug(input.slug);
		if (existing) {
			db.prepare(
				`UPDATE mcp_servers SET name = ?, description = ?, version = ?, transport = 'stdio', source = 'internal' WHERE slug = ?`
			).run(input.name, input.description, input.version, input.slug);
			return this.getBySlug(input.slug)!;
		}
		db.prepare(
			`INSERT INTO mcp_servers (slug, name, description, version, transport, source, is_enabled)
			 VALUES (?, ?, ?, ?, 'stdio', 'internal', 1)`
		).run(input.slug, input.name, input.description, input.version);
		return this.getBySlug(input.slug)!;
	},

	/** Remove internal rows whose code definition no longer exists (keeps the slugs in `keep`). */
	pruneInternalExcept(keep: string[]): void {
		const db = getDatabase();
		const rows = this.getBySource('internal');
		const keepSet = new Set(keep);
		for (const row of rows) {
			if (!keepSet.has(row.slug)) db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(row.id);
		}
	}
};
