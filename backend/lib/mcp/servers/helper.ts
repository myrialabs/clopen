/**
 * Helper to define MCP servers with automatic metadata extraction
 *
 * Stores both the Claude SDK server instance AND raw tool definitions
 * so the same source can be used for Claude Code (in-process) and
 * Open Code (stdio subprocess via @modelcontextprotocol/sdk).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

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
 * - Open Code stdio: schema/description for registration, handler via bridge
 * - MCP bridge: handler for in-process execution
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
	meta: {
		readonly name: TName;
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

	// Convert tools object to SDK format (array of tools)
	const sdkTools = toolNames.map((toolName) => {
		const toolDef = config.tools[toolName] as any;
		// If schema is not provided, use empty object
		const schema = toolDef.schema || {};

		// Store raw definition for reuse
		toolDefs[toolName as string] = {
			description: toolDef.description,
			schema,
			handler: toolDef.handler,
		};

		return tool(toolName as string, toolDef.description, schema, toolDef.handler);
	});

	// Create SDK server
	const server = createSdkMcpServer({
		name: config.name,
		version: config.version,
		tools: sdkTools
	});

	// Return server with metadata
	return {
		server,
		meta: {
			name: config.name,
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

	for (const server of servers) {
		metadata[server.meta.name] = server.meta;
		registry[server.meta.name] = server.server;
	}

	return {
		metadata: metadata as {
			[K in T[number]['meta']['name']]: Extract<T[number], { meta: { name: K } }>['meta']
		},
		registry: registry as {
			[K in T[number]['meta']['name']]: Extract<T[number], { meta: { name: K } }>['server']
		}
	};
}
