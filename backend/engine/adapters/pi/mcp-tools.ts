/**
 * MCP → Pi custom-tool bridge.
 *
 * Pi has NO native MCP support (by design — see the pi README). Because Pi runs
 * IN-PROCESS, we don't need the `/mcp` HTTP bridge the other engines use: we
 * expose each enabled Clopen MCP tool directly as a Pi custom tool
 * (`ToolDefinition`) whose `execute` calls the tool handler in-process.
 *
 *   - INTERNAL servers (`defineServer()` — e.g. browser-automation): the handler
 *     runs bound to the stream's project context (AsyncLocalStorage) with an
 *     abort short-circuit, exactly like Claude's in-process path.
 *   - EXTERNAL servers (user-installed, `mcp_servers` table): proxied to the
 *     upstream server via `callExternalServerTool`.
 *
 * Tool names use the canonical `mcp__<namespace>__<tool>` form so the unified UI
 * + `toCanonicalToolName()` render them identically to the other engines.
 *
 * Note: MCP tool JSON schemas are surfaced to the model through the tool
 * DESCRIPTION (Pi tool `parameters` stays a permissive object) — the handler
 * validates the arguments, so this is lossless for execution.
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { McpExecutionContext } from '../../types';
import {
	getEnabledServerNames,
	isToolEnabled,
	getEnabledExternalServers,
	listExternalServerTools,
	callExternalServerTool,
	projectContextService,
	serverMetadata,
} from '../../../mcp';
import { debug } from '$shared/utils/logger';

type McpContentItem = { type: string; text?: string; data?: string; mimeType?: string };

/** Permissive object schema — arguments are validated by the tool handler. */
const OPEN_PARAMS = Type.Object({}, { additionalProperties: true });

/** Map an MCP content array into Pi's `(TextContent | ImageContent)[]`. */
function toPiContent(raw: unknown): (TextContent | ImageContent)[] {
	const items = Array.isArray(raw) ? (raw as McpContentItem[]) : [];
	const out: (TextContent | ImageContent)[] = [];
	for (const item of items) {
		if (item?.type === 'image' && typeof item.data === 'string') {
			out.push({ type: 'image', data: item.data, mimeType: item.mimeType || 'image/png' });
		} else if (typeof item?.text === 'string') {
			out.push({ type: 'text', text: item.text });
		} else if (item != null) {
			out.push({ type: 'text', text: JSON.stringify(item) });
		}
	}
	if (out.length === 0) out.push({ type: 'text', text: '' });
	return out;
}

/**
 * Build the set of Pi custom tools mirroring every enabled internal + external
 * MCP tool. Scoped to the active Profile via `profileFilter` (server ids).
 */
export async function buildPiMcpTools(
	context: McpExecutionContext | undefined,
	profileFilter: Set<string> | undefined,
): Promise<ToolDefinition[]> {
	const tools: ToolDefinition[] = [];

	// ── Internal servers (in-process handlers) ──
	for (const serverName of getEnabledServerNames()) {
		if (profileFilter && !profileFilter.has(serverName)) continue;
		const meta = (serverMetadata as Record<string, { tools: readonly string[]; toolDefs: Record<string, { description: string; schema: Record<string, unknown>; handler: (args: unknown) => Promise<{ content: McpContentItem[]; isError?: boolean }> }> }>)[serverName];
		if (!meta) continue;

		// meta.tools holds RAW tool names (the toolDefs keys). getEnabledToolsForServer()
		// returns the `mcp__<server>__<tool>` form, which would never match toolDefs.
		for (const toolName of meta.tools) {
			if (!isToolEnabled(serverName, toolName)) continue;
			const def = meta.toolDefs[toolName];
			if (!def) continue;
			const fullName = `mcp__${serverName}__${toolName}`;
			const argKeys = Object.keys(def.schema ?? {});
			tools.push({
				name: fullName,
				label: toolName,
				description: `${def.description}${argKeys.length ? `\n\nArguments: ${argKeys.join(', ')}` : ''}`,
				parameters: OPEN_PARAMS,
				execute: async (_toolCallId: string, params: unknown) => {
					const run = async () => {
						const signal = projectContextService.getCurrentSignal();
						if (signal?.aborted) {
							return { content: [{ type: 'text' as const, text: `Tool ${fullName} was cancelled.` }], details: {} };
						}
						const result = await def.handler(params ?? {});
						return { content: toPiContent(result?.content), details: {} };
					};
					return context ? projectContextService.runWithContextAsync(context, run) : run();
				},
			} as ToolDefinition);
		}
	}

	// ── External servers (proxied upstream) ──
	for (const server of getEnabledExternalServers(profileFilter)) {
		let externalTools;
		try {
			externalTools = await listExternalServerTools(server.slug);
		} catch (error) {
			debug.warn('mcp', `Pi MCP bridge: could not list tools for "${server.slug}" (skipping):`, error);
			continue;
		}
		for (const tool of externalTools) {
			const fullName = `mcp__${server.namespace}__${tool.name}`;
			const schemaText = tool.inputSchema ? `\n\nInput JSON schema:\n${JSON.stringify(tool.inputSchema)}` : '';
			tools.push({
				name: fullName,
				label: tool.name,
				description: `${tool.description ?? tool.name}${schemaText}`,
				parameters: OPEN_PARAMS,
				execute: async (_toolCallId: string, params: unknown) => {
					const result = (await callExternalServerTool(server.slug, tool.name, params ?? {})) as { content?: unknown } | undefined;
					return { content: toPiContent(result?.content), details: {} };
				},
			} as ToolDefinition);
		}
	}

	debug.log('mcp', `Pi MCP bridge: ${tools.length} tool(s) exposed`);
	return tools;
}
