/**
 * MCP Server CRUD Handlers
 *
 * Manage external (user-installed) MCP servers stored in `mcp_servers`:
 *   - mcp:list      — installed servers (env values redacted to key names)
 *   - mcp:install   — persist a server from the catalog (or a custom entry)
 *   - mcp:toggle    — enable / disable
 *   - mcp:uninstall — remove
 *
 * Mutations are admin-gated in `backend/auth/permissions.ts`. Changes take
 * effect on the next chat stream (engines read MCP config when a stream starts).
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { mcpServerQueries, type McpConfigField, type McpServerRow, type McpTransport } from '$backend/database/queries';
import { slugifyRegistryName, externalNamespace, refreshInternalEnabledCache } from '$backend/mcp';

const TRANSPORT_SCHEMA = t.Union([t.Literal('stdio'), t.Literal('http'), t.Literal('sse')]);

// UI field metadata captured from the catalog at install time. Engines never
// read this — it only lets "Configure" render the same labelled fields as install.
const CONFIG_FIELD_SCHEMA = t.Object({
	name: t.String(),
	kind: t.Union([t.Literal('env'), t.Literal('header')]),
	description: t.Optional(t.String()),
	isRequired: t.Boolean(),
	isSecret: t.Boolean()
});

const INSTALLED_SERVER_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	namespace: t.String(),
	name: t.String(),
	description: t.Union([t.String(), t.Null()]),
	registryName: t.Union([t.String(), t.Null()]),
	version: t.Union([t.String(), t.Null()]),
	transport: TRANSPORT_SCHEMA,
	command: t.Union([t.String(), t.Null()]),
	args: t.Array(t.String()),
	// Full values are returned (not redacted): the whole MCP surface is
	// admin-only (see auth/permissions.ts), and the Settings UI shows values so
	// admins can review and edit what each engine receives.
	env: t.Record(t.String(), t.String()),
	headers: t.Record(t.String(), t.String()),
	configSchema: t.Array(CONFIG_FIELD_SCHEMA),
	url: t.Union([t.String(), t.Null()]),
	source: t.String(),
	enabled: t.Boolean(),
	createdAt: t.String()
});

function toDTO(row: McpServerRow) {
	let args: string[] = [];
	let env: Record<string, string> = {};
	let headers: Record<string, string> = {};
	let configSchema: McpConfigField[] = [];
	try { args = JSON.parse(row.args); } catch { /* ignore */ }
	try { env = JSON.parse(row.env); } catch { /* ignore */ }
	try { headers = JSON.parse(row.headers); } catch { /* ignore */ }
	try { configSchema = JSON.parse(row.config_schema); } catch { /* ignore */ }
	return {
		id: row.id,
		slug: row.slug,
		namespace: externalNamespace(row.slug),
		name: row.name,
		description: row.description,
		registryName: row.registry_name,
		version: row.version,
		transport: row.transport,
		command: row.command,
		args,
		env,
		headers,
		configSchema,
		url: row.url,
		source: row.source,
		enabled: row.is_enabled === 1,
		createdAt: row.created_at
	};
}

/** Derive a slug that doesn't collide with an already-installed server. */
function uniqueSlug(base: string): string {
	const root = slugifyRegistryName(base);
	if (!mcpServerQueries.getBySlug(root)) return root;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${root}-${i}`;
		if (!mcpServerQueries.getBySlug(candidate)) return candidate;
	}
	return `${root}-${Date.now()}`;
}

export const mcpCrudHandler = createRouter()
	.http('mcp:list', {
		data: t.Object({}),
		response: t.Object({ servers: t.Array(INSTALLED_SERVER_SCHEMA) })
	}, async () => {
		debug.log('path', 'mcp:list');
		return { servers: mcpServerQueries.getAll().map(toDTO) };
	})
	.http('mcp:install', {
		data: t.Object({
			slug: t.String(),
			name: t.String(),
			description: t.Optional(t.String()),
			registryName: t.Optional(t.String()),
			version: t.Optional(t.String()),
			transport: TRANSPORT_SCHEMA,
			command: t.Optional(t.String()),
			args: t.Optional(t.Array(t.String())),
			url: t.Optional(t.String()),
			env: t.Optional(t.Record(t.String(), t.String())),
			headers: t.Optional(t.Record(t.String(), t.String())),
			configSchema: t.Optional(t.Array(CONFIG_FIELD_SCHEMA)),
			source: t.Optional(t.Union([t.Literal('registry'), t.Literal('custom')]))
		}),
		response: t.Object({ server: INSTALLED_SERVER_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `mcp:install ${data.slug} (${data.transport})`);

		if (data.transport === 'stdio' && !data.command) {
			throw new Error('A stdio MCP server requires a command');
		}
		if ((data.transport === 'http' || data.transport === 'sse') && !data.url) {
			throw new Error('A remote MCP server requires a URL');
		}

		const slug = uniqueSlug(data.slug || data.name);
		const row = mcpServerQueries.insert({
			slug,
			name: data.name,
			description: data.description ?? null,
			registryName: data.registryName ?? null,
			version: data.version ?? null,
			transport: data.transport as McpTransport,
			command: data.command ?? null,
			args: data.args ?? [],
			env: data.env ?? {},
			url: data.url ?? null,
			headers: data.headers ?? {},
			configSchema: data.configSchema ?? [],
			source: data.source ?? 'registry'
		});
		debug.log('mcp', `📥 Installed external MCP server: ${slug}`);
		return { server: toDTO(row) };
	})
	.http('mcp:toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ server: INSTALLED_SERVER_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `mcp:toggle ${data.id} → ${data.enabled}`);
		const existing = mcpServerQueries.getById(data.id);
		if (!existing) throw new Error('MCP server not found');
		mcpServerQueries.setEnabled(data.id, data.enabled);
		// Internal servers are gated through an in-memory cache — refresh it so
		// the toggle takes effect on the next chat stream.
		if (existing.source === 'internal') refreshInternalEnabledCache();
		return { server: toDTO(mcpServerQueries.getById(data.id)!) };
	})
	.http('mcp:update-config', {
		data: t.Object({
			id: t.Number(),
			env: t.Optional(t.Record(t.String(), t.String())),
			headers: t.Optional(t.Record(t.String(), t.String()))
		}),
		response: t.Object({ server: INSTALLED_SERVER_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `mcp:update-config ${data.id}`);
		const existing = mcpServerQueries.getById(data.id);
		if (!existing) throw new Error('MCP server not found');
		if (existing.source === 'internal') throw new Error('Built-in MCP servers cannot be configured');
		// Drop blank values so we never store empty env/header entries.
		const clean = (obj?: Record<string, string>) =>
			Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v.trim() !== ''));
		mcpServerQueries.updateConfig(data.id, clean(data.env), clean(data.headers));
		debug.log('mcp', `🔧 Updated config for external MCP server: ${existing.slug}`);
		return { server: toDTO(mcpServerQueries.getById(data.id)!) };
	})
	.http('mcp:uninstall', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `mcp:uninstall ${data.id}`);
		const existing = mcpServerQueries.getById(data.id);
		if (!existing) throw new Error('MCP server not found');
		if (existing.source === 'internal') throw new Error('Built-in MCP servers cannot be uninstalled');
		mcpServerQueries.remove(data.id);
		debug.log('mcp', `🗑️ Uninstalled external MCP server: ${existing.slug}`);
		return { success: true };
	});
