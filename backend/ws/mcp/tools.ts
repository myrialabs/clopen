/**
 * MCP Tool-level Control + Inspector Handlers
 *
 * Deepens the installed-server surface with per-tool control and a playground:
 *   - mcp:tools              — list a server's live tools + their exposure state
 *   - mcp:set-tool-overrides — persist per-tool + per-engine enable state
 *   - mcp:call-tool          — inspector: invoke one tool and return its result
 *
 * All three go through the SAME upstream introspection path the bridge uses
 * (`backend/mcp/external/proxy.ts`), so what Settings shows matches what the
 * engines receive. Mutations are admin-gated in `backend/auth/permissions.ts`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { mcpServerQueries, type McpToolOverrides } from '$backend/database/queries';
import {
	listExternalServerTools,
	callExternalServerTool,
	parseToolOverrides,
	resolveToolExposure,
	pruneToolOverrides,
	getValidAccessToken
} from '$backend/mcp';

/** A single per-tool override the client sends back (only restrictions matter). */
const TOOL_OVERRIDE_SCHEMA = t.Object({
	enabled: t.Optional(t.Boolean()),
	engines: t.Optional(t.Record(t.String(), t.Boolean()))
});

/**
 * Load a non-internal server by id, or throw. External MCP introspection makes
 * no sense for the in-process internal servers (their tools are code-defined).
 */
function requireExternal(id: number) {
	const row = mcpServerQueries.getById(id);
	if (!row) throw new Error('MCP server not found');
	if (row.source === 'internal') throw new Error('Built-in MCP servers cannot be inspected');
	return row;
}

/** Refresh a near-expiry OAuth token so the live upstream connection authenticates. */
async function ensureFreshToken(id: number, hasOAuth: boolean): Promise<void> {
	if (hasOAuth) await getValidAccessToken(id);
}

export const mcpToolsHandler = createRouter()
	.http('mcp:tools', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({
			tools: t.Array(t.Object({
				name: t.String(),
				description: t.Optional(t.String()),
				inputSchema: t.Any(),
				// Effective exposure resolved from stored overrides (default: all on).
				enabled: t.Boolean(),
				engines: t.Record(t.String(), t.Boolean())
			}))
		})
	}, async ({ data }) => {
		debug.log('path', `mcp:tools ${data.id}`);
		const row = requireExternal(data.id);
		await ensureFreshToken(row.id, !!row.oauth);
		const live = await listExternalServerTools(row.slug);
		const overrides = parseToolOverrides(row.tool_overrides);
		return {
			tools: live.map(tool => {
				const exposure = resolveToolExposure(overrides[tool.name]);
				return {
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					enabled: exposure.enabled,
					engines: exposure.engines
				};
			})
		};
	})
	.http('mcp:set-tool-overrides', {
		data: t.Object({
			id: t.Number(),
			overrides: t.Record(t.String(), TOOL_OVERRIDE_SCHEMA)
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `mcp:set-tool-overrides ${data.id}`);
		const row = requireExternal(data.id);
		// Prune no-op entries so the column only ever stores real restrictions.
		const overrides = pruneToolOverrides(data.overrides as McpToolOverrides);
		mcpServerQueries.updateToolOverrides(row.id, overrides);
		debug.log('mcp', `🎛️ Updated tool exposure for external MCP server: ${row.slug} (${Object.keys(overrides).length} restricted)`);
		return { success: true };
	})
	.http('mcp:call-tool', {
		// Inspector / playground: invoke one tool with the given arguments and
		// return its raw MCP result (including `isError` results, so the UI can
		// render tool-reported failures). Connection failures throw.
		data: t.Object({
			id: t.Number(),
			tool: t.String(),
			args: t.Optional(t.Any())
		}),
		response: t.Object({ result: t.Any() })
	}, async ({ data }) => {
		debug.log('path', `mcp:call-tool ${data.id} → ${data.tool}`);
		const row = requireExternal(data.id);
		await ensureFreshToken(row.id, !!row.oauth);
		const result = await callExternalServerTool(row.slug, data.tool, data.args ?? {});
		return { result };
	});
