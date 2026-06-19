/**
 * Helper to define MCP servers with automatic metadata extraction
 *
 * Stores both the Claude SDK server instance AND raw tool definitions
 * so the same source can be used for Claude Code (in-process) and
 * Open Code (remote HTTP MCP via @modelcontextprotocol/sdk).
 *
 * Claude Code: createSdkMcpServer() → in-process MCP server
 * Open Code:   createRemoteMcpServer() → HTTP MCP server (same process, same handlers)
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from "zod";
import { projectContextService } from '../project-context';
import { validateMcpOutput } from '../output-validator';

/**
 * Infer argument types from Zod schema
 */
type InferArgs<TSchema extends Record<string, z.ZodType<any>>> = {
	[K in keyof TSchema]: z.infer<TSchema[K]>;
};

/**
 * Content types for MCP responses
 */
type MCPContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Tool handler type - infers args type from schema
 */
type ToolHandler<TSchema extends Record<string, z.ZodType<any>> | undefined> =
	TSchema extends Record<string, z.ZodType<any>>
		? (args: InferArgs<TSchema>) => Promise<{ content: Array<MCPContent>; isError?: boolean }>
		: () => Promise<{ content: Array<MCPContent>; isError?: boolean }>;

/**
 * Raw tool definition — schema, description, and handler.
 * Single source of truth used by:
 * - Claude Code: in-process via createSdkMcpServer
 * - Open Code: remote HTTP MCP via createRemoteMcpServer (in-process handlers)
 */
export interface RawToolDef {
	description: string;
	schema: Record<string, z.ZodType<any>>;
	handler: (args: any) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
}

/**
 * Server instance with metadata
 */
interface ServerWithMeta<
	TName extends string,
	TToolNames extends readonly string[]
> {
	server: ReturnType<typeof createSdkMcpServer>;
	/** Factory that creates a fresh SDK server instance (new Protocol, safe for concurrent use) */
	createInstance: () => ReturnType<typeof createSdkMcpServer>;
	meta: {
		readonly name: TName;
		/** Human-facing title shown in Settings → MCP and the Chat tool header. */
		readonly title: string;
		/** Short description of what this server provides. */
		readonly description: string;
		/** Semantic version, e.g. `1.0.0`. */
		readonly version: string;
		readonly tools: TToolNames;
		/** Raw tool definitions (schema + description) for reuse by other transports */
		readonly toolDefs: Record<string, RawToolDef>;
	};
}

/**
 * Define an MCP server with automatic metadata extraction and full type inference
 */
export function defineServer<
	const TConfig extends {
		name: string;
		title: string;
		description: string;
		version: string;
		tools: Record<string, { description: string; schema?: any; handler: any }>;
	}
>(
	config: TConfig & {
		tools: {
			[K in keyof TConfig['tools']]: TConfig['tools'][K] extends { schema: infer S extends Record<string, z.ZodType<any>> }
				? { description: string; schema: S; handler: ToolHandler<S> }
				: { description: string; handler: ToolHandler<undefined> }
		}
	}
): ServerWithMeta<TConfig['name'], ReadonlyArray<keyof TConfig['tools'] & string>> {
	// Extract tool names
	const toolNames = Object.keys(config.tools) as Array<keyof TConfig['tools'] & string>;

	// Build raw tool definitions (engine-agnostic)
	const toolDefs: Record<string, RawToolDef> = {};

	// Build raw tool definitions (engine-agnostic) and store for reuse
	toolNames.forEach((toolName) => {
		const toolDef = config.tools[toolName] as any;
		const schema = toolDef.schema || {};

		toolDefs[toolName as string] = {
			description: toolDef.description,
			schema,
			handler: toolDef.handler,
		};
	});

	// Factory: creates a fresh SDK server instance with new Protocol (safe for concurrent use)
	const createInstance = () => {
		const sdkTools = toolNames.map((toolName) => {
			const def = toolDefs[toolName as string];
			return tool(toolName as string, def.description, def.schema, def.handler as any);
		});

		return createSdkMcpServer({
			name: config.name,
			version: config.version,
			tools: sdkTools
		});
	};

	// Return server with metadata and factory
	return {
		server: createInstance(),
		createInstance,
		meta: {
			name: config.name,
			title: config.title,
			description: config.description,
			version: config.version,
			tools: toolNames as any,
			toolDefs,
		}
	};
}

/**
 * Build server registries from array of servers
 */
export function buildServerRegistries<
	T extends readonly ServerWithMeta<string, readonly string[]>[]
>(servers: T) {
	const metadata = {} as any;
	const registry = {} as any;
	const factories = {} as any;

	for (const server of servers) {
		metadata[server.meta.name] = server.meta;
		registry[server.meta.name] = server.server;
		factories[server.meta.name] = server.createInstance;
	}

	return {
		metadata: metadata as {
			[K in T[number]['meta']['name']]: Extract<T[number], { meta: { name: K } }>['meta']
		},
		registry: registry as {
			[K in T[number]['meta']['name']]: Extract<T[number], { meta: { name: K } }>['server']
		},
		factories: factories as {
			[K in T[number]['meta']['name']]: () => Extract<T[number], { meta: { name: K } }>['server']
		}
	};
}

// ============================================================================
// Remote MCP Server for Open Code (HTTP transport, in-process execution)
// ============================================================================

/**
 * Create a McpServer instance (from @modelcontextprotocol/sdk) with tools registered
 * from the same RawToolDef definitions used by Claude Code.
 *
 * This is the Open Code equivalent of createSdkMcpServer() for Claude Code.
 * Handlers execute directly in-process — no subprocess, no bridge.
 *
 * @param servers - Server definitions from defineServer()
 * @param enabledConfig - Which servers/tools are enabled (from mcpServersConfig)
 */
export function createRemoteMcpServer(
	servers: readonly ServerWithMeta<string, readonly string[]>[],
	enabledConfig: Record<string, { enabled: boolean; tools: readonly string[] }>
): McpServer {
	const mcpServer = new McpServer({
		name: 'clopen-mcp',
		version: '1.0.0',
	});

	for (const srv of servers) {
		const config = enabledConfig[srv.meta.name];
		if (!config?.enabled) continue;

		for (const toolName of config.tools) {
			const def = srv.meta.toolDefs[toolName as string];
			if (!def) continue;

			mcpServer.registerTool(toolName as string, {
				description: def.description,
				// MCP SDK 1.29 typed `inputSchema` as `ZodRawShapeCompat` (Record of
				// z3 | z4-core schemas). Our shapes are zod v4 instances whose
				// nominal type doesn't satisfy that union, but they are accepted
				// at runtime. Cast to bridge the mismatch.
				inputSchema: def.schema as Record<string, any>,
			}, async (args: Record<string, unknown>) => {
				// Fast-fail when the owning chat stream has already been
				// cancelled — the handler never runs. Without this, the
				// engine subprocess dies on cancel but in-flight HTTP-MCP
				// tool calls continue to drive puppeteer ops, surfacing as
				// "preview keeps moving by itself" after interrupt.
				const signal = projectContextService.getCurrentSignal();
				if (signal?.aborted) {
					return {
						content: [{ type: 'text' as const, text: `Tool ${String(toolName)} was cancelled because the chat stream was interrupted.` }],
						isError: true,
					} as any;
				}
				const result = await def.handler(args) as any;
				if (result?.content) {
					result.content = validateMcpOutput(result.content, toolName as string);
				}
				return result;
			});
		}
	}

	return mcpServer;
}
