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
import { mcpServerQueries, type McpServerRow, type McpTransport } from '$backend/database/queries';
import { slugifyRegistryName, externalNamespace, refreshInternalEnabledCache } from '$backend/mcp';

const TRANSPORT_SCHEMA = t.Union([t.Literal('stdio'), t.Literal('http'), t.Literal('sse')]);

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
	envKeys: t.Array(t.String()),
	headerKeys: t.Array(t.String()),
	url: t.Union([t.String(), t.Null()]),
	source: t.String(),
	enabled: t.Boolean(),
	createdAt: t.String()
});

function toDTO(row: McpServerRow) {
	let args: string[] = [];
	let envKeys: string[] = [];
	let headerKeys: string[] = [];
	try { args = JSON.parse(row.args); } catch { /* ignore */ }
	try { envKeys = Object.keys(JSON.parse(row.env)); } catch { /* ignore */ }
	try { headerKeys = Object.keys(JSON.parse(row.headers)); } catch { /* ignore */ }
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
		envKeys,
		headerKeys,
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
