/**
 * MCP → Cline custom-tool bridge.
 *
 * We drive Cline through the stateless `Agent`, which runs IN-PROCESS, so we
 * don't need the `/mcp` HTTP bridge the subprocess engines use: we expose each
 * enabled Clopen MCP tool directly as a Cline custom tool (`createTool`) whose
 * `execute` calls the tool handler in-process.
 *
 *   - INTERNAL servers (`defineServer()` — e.g. browser-automation): the handler
 *     runs bound to the stream's project context (AsyncLocalStorage) with an
 *     abort short-circuit, exactly like Claude's in-process path.
 *   - EXTERNAL servers (user-installed, `mcp_servers` table): proxied to the
 *     upstream server via `callExternalServerTool`.
 *
 * Tool names use the canonical `mcp__<namespace>__<tool>` form so the unified UI
 * + `toCanonicalToolName()` render them identically to the other engines.
 */

import { createTool } from '@cline/sdk';
import type { AgentTool, AgentToolContext } from '@cline/sdk';
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
const OPEN_PARAMS = { type: 'object', additionalProperties: true } as const;

/** Extract plain text from an MCP content array for the model to read. */
function toResultText(raw: unknown): string {
	const items = Array.isArray(raw) ? (raw as McpContentItem[]) : [];
	const parts: string[] = [];
	for (const item of items) {
		if (typeof item?.text === 'string') {
			parts.push(item.text);
		} else if (item?.type === 'image') {
			parts.push('[image]');
		} else if (item != null) {
			parts.push(JSON.stringify(item));
		}
	}
	return parts.join('\n');
}

/**
 * Build the set of Cline custom tools mirroring every enabled internal + external
 * MCP tool. Scoped to the active Profile via `profileFilter` (server ids).
 */
export async function buildClineMcpTools(
	context: McpExecutionContext | undefined,
	profileFilter: Set<string> | undefined,
): Promise<AgentTool[]> {
	const tools: AgentTool[] = [];

	// ── Internal servers (in-process handlers) ──
	for (const serverName of getEnabledServerNames()) {
		if (profileFilter && !profileFilter.has(serverName)) continue;
		const meta = (serverMetadata as Record<string, { tools: readonly string[]; toolDefs: Record<string, { description: string; schema: Record<string, unknown>; handler: (args: unknown) => Promise<{ content: McpContentItem[]; isError?: boolean }> }> }>)[serverName];
		if (!meta) continue;

		for (const toolName of meta.tools) {
			if (!isToolEnabled(serverName, toolName)) continue;
			const def = meta.toolDefs[toolName];
			if (!def) continue;
			const fullName = `mcp__${serverName}__${toolName}`;
			const argKeys = Object.keys(def.schema ?? {});
			tools.push(createTool({
				name: fullName,
				description: `${def.description}${argKeys.length ? `\n\nArguments: ${argKeys.join(', ')}` : ''}`,
				inputSchema: OPEN_PARAMS,
				async execute(params: unknown) {
					const run = async () => {
						const signal = projectContextService.getCurrentSignal();
						if (signal?.aborted) return `Tool ${fullName} was cancelled.`;
						const result = await def.handler(params ?? {});
						return toResultText(result?.content);
					};
					return context ? projectContextService.runWithContextAsync(context, run) : run();
				},
			}) as AgentTool);
		}
	}

	// ── External servers (proxied upstream) ──
	for (const server of getEnabledExternalServers(profileFilter)) {
		let externalTools;
		try {
			externalTools = await listExternalServerTools(server.slug);
		} catch (error) {
			debug.warn('mcp', `Cline MCP bridge: could not list tools for "${server.slug}" (skipping):`, error);
			continue;
		}
		for (const tool of externalTools) {
			const fullName = `mcp__${server.namespace}__${tool.name}`;
			const schemaText = tool.inputSchema ? `\n\nInput JSON schema:\n${JSON.stringify(tool.inputSchema)}` : '';
			tools.push(createTool({
				name: fullName,
				description: `${tool.description ?? tool.name}${schemaText}`,
				inputSchema: OPEN_PARAMS,
				async execute(params: unknown) {
					const result = (await callExternalServerTool(server.slug, tool.name, params ?? {})) as { content?: unknown } | undefined;
					return toResultText(result?.content);
				},
			}) as AgentTool);
		}
	}

	debug.log('mcp', `Cline MCP bridge: ${tools.length} tool(s) exposed`);
	return tools;
}
