/**
 * MCP Catalog Handler
 *
 * Proxies the official MCP registry (registry.modelcontextprotocol.io) so the
 * Settings → MCP "Browse" tab can search and paginate installable servers
 * without the frontend talking to the registry directly.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { listRegistryServers } from '$backend/mcp';

const ENV_VAR_SCHEMA = t.Object({
	name: t.String(),
	description: t.Optional(t.String()),
	isRequired: t.Boolean(),
	isSecret: t.Boolean(),
	default: t.Optional(t.String())
});

const CATALOG_SERVER_SCHEMA = t.Object({
	registryName: t.String(),
	slug: t.String(),
	title: t.String(),
	description: t.String(),
	version: t.String(),
	transport: t.Union([t.Literal('stdio'), t.Literal('http'), t.Literal('sse')]),
	command: t.Optional(t.String()),
	args: t.Optional(t.Array(t.String())),
	url: t.Optional(t.String()),
	envVars: t.Array(ENV_VAR_SCHEMA),
	headerVars: t.Array(ENV_VAR_SCHEMA),
	packageHint: t.Optional(t.String())
});

export const mcpCatalogHandler = createRouter()
	.http('mcp:catalog', {
		data: t.Object({
			search: t.Optional(t.String()),
			cursor: t.Optional(t.String()),
			limit: t.Optional(t.Number())
		}),
		response: t.Object({
			servers: t.Array(CATALOG_SERVER_SCHEMA),
			nextCursor: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		debug.log('path', `mcp:catalog search="${data.search ?? ''}"`);
		const page = await listRegistryServers({
			search: data.search,
			cursor: data.cursor,
			limit: data.limit
		});
		return { servers: page.servers, nextCursor: page.nextCursor };
	});
