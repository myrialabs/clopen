/**
 * Pi's native MCP wiring, end to end against the real SDK: a loopback MCP
 * server stands in for Clopen's bridge and a scripted OpenAI-compatible
 * endpoint plays the model, so the turn runs through Pi's own tool pipeline.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { EngineOutput, MessageEngine } from '$shared/types/unified';

// The SDK lives in the managed stack dir at runtime; tests load the repo's copy.
// Keep the whole module surface — `mock.module` replaces it for the process.
const realLoader = { ...(await import('$backend/engine/sdk-loader')) };
mock.module('$backend/engine/sdk-loader', () => ({
	...realLoader,
	loadEngineSdk: async (_engine: string, packageName: string) => import(packageName),
}));

const sdk = await import('@earendil-works/pi-coding-agent');
const { createPiMcpExtension, resolvePiToolName } = await import('./mcp');
const { createPiMessageConverter } = await import('./message-converter');

const TOKEN = 'test-service-token';

let dir: string;
let mcpServer: ReturnType<typeof Bun.serve>;
let llmServer: ReturnType<typeof Bun.serve>;
const mcpCalls: string[] = [];
let closedMcpSessions = 0;
const declaredTools: string[][] = [];

/** Stateful MCP server, so a client closing its session is observable (DELETE). */
function startMcpServer(): ReturnType<typeof Bun.serve> {
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
	return Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 });
			const sessionId = request.headers.get('mcp-session-id');
			if (sessionId && transports.has(sessionId)) {
				if (request.method === 'DELETE') closedMcpSessions++;
				return transports.get(sessionId)!.handleRequest(request);
			}
			const server = new McpServer({ name: 'fixture', version: '1.0.0' });
			server.registerTool('get-page', { description: 'Read a page', inputSchema: { id: z.string() } }, async ({ id }) => {
				mcpCalls.push(`get-page:${id}`);
				return { content: [{ type: 'text', text: `page ${id}` }] };
			});
			server.registerTool('delete-page', { description: 'Delete a page', inputSchema: {} }, async () => {
				mcpCalls.push('delete-page');
				return { content: [{ type: 'text', text: 'deleted' }] };
			});
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				enableJsonResponse: true,
				onsessioninitialized: (id) => { transports.set(id, transport); },
			});
			await server.connect(transport);
			return transport.handleRequest(request);
		},
	});
}

/** Chat-completions SSE: the first request calls both MCP tools, the next one answers. */
function startModelServer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const body = await request.json() as { tools?: { function: { name: string } }[] };
			declaredTools.push((body.tools ?? []).map((tool) => tool.function.name));
			const base = { id: 'chunk', object: 'chat.completion.chunk', created: 0, model: 'scripted' };
			const delta = declaredTools.length === 1
				? { role: 'assistant', tool_calls: [
					{ index: 0, id: 'call_read', type: 'function', function: { name: 'mcp__ext_server__get_page', arguments: '{"id":"42"}' } },
					{ index: 1, id: 'call_delete', type: 'function', function: { name: 'mcp__ext_server__delete_page', arguments: '{}' } },
				] }
				: { role: 'assistant', content: 'done' };
			const finish = declaredTools.length === 1 ? 'tool_calls' : 'stop';
			const events = [
				{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
				{ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
			];
			const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
		},
	});
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'clopen-pi-mcp-'));
	mcpServer = startMcpServer();
	llmServer = startModelServer();
});

afterAll(() => {
	mcpServer.stop(true);
	llmServer.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe('resolvePiToolName', () => {
	test('passes non-MCP names and a missing session through', () => {
		expect(resolvePiToolName(null, 'mcp__a_b__c')).toBe('mcp__a_b__c');
		const session = { getToolDefinition: () => undefined } as unknown as AgentSession;
		expect(resolvePiToolName(session, 'read')).toBe('read');
		expect(resolvePiToolName(session, 'mcp__unknown__tool')).toBe('mcp__unknown__tool');
	});

	test('recovers the namespace and tool name Pi sanitized, from the label', () => {
		const session = { getToolDefinition: () => ({ label: 'my-server/get.page' }) } as unknown as AgentSession;
		expect(resolvePiToolName(session, 'mcp__my_server__get_page')).toBe('mcp__my-server__get.page');
	});
});

describe('Pi native MCP turn', () => {
	test('declares, gates by canonical name, runs and closes MCP tools', async () => {
		const agentDir = join(dir, 'agent');
		const cwd = join(dir, 'project');
		const modelsPath = join(dir, 'models.json');
		writeFileSync(modelsPath, JSON.stringify({
			providers: {
				scripted: {
					baseUrl: `http://localhost:${llmServer.port}/v1`,
					api: 'openai-completions',
					apiKey: 'unused',
					models: [{ id: 'scripted', name: 'Scripted', reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				},
			},
		}));
		const runtime = await sdk.ModelRuntime.create({ modelsPath, modelsStorePath: join(dir, 'models-store.json') });
		const model = runtime.getModels().find((m) => m.provider === 'scripted')!;

		let session: AgentSession | null = null;
		const blocked: string[] = [];
		const permissionBlocker = (pi: ExtensionAPI) => {
			pi.on('tool_call', async (event: { toolName: string }) => {
				const toolName = resolvePiToolName(session, event.toolName);
				if (toolName !== 'mcp__ext-server__delete-page') return undefined;
				blocked.push(toolName);
				return { block: true, reason: 'denied' };
			});
		};
		const mcpExtension = await createPiMcpExtension({
			'ext-server': {
				type: 'http',
				url: `http://localhost:${mcpServer.port}/mcp`,
				headers: { Authorization: `Bearer ${TOKEN}` },
				exposure: 'direct',
				timeout: 60,
			},
		});
		const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, extensionFactories: [permissionBlocker, mcpExtension] });
		await resourceLoader.reload();
		({ session } = await sdk.createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: runtime,
			resourceLoader,
			excludeTools: ['write'],
			sessionManager: sdk.SessionManager.inMemory(cwd),
			settingsManager: sdk.SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'write'] }),
		}));
		await session.bindExtensions({});

		const converter = createPiMessageConverter({
			engine: { type: 'pi' } as MessageEngine,
			sessionId: session.sessionId,
			resolveToolName: (name) => resolvePiToolName(session, name),
		});
		const outputs: EngineOutput[] = [];
		session.subscribe((event) => { outputs.push(...converter.convert(event)); });
		await session.prompt('go');

		// MCP tools join the builtins instead of being filtered out by them.
		expect(declaredTools[0]).toEqual(['read', 'bash', 'mcp__ext_server__get_page', 'mcp__ext_server__delete_page']);
		const toolUses = outputs.flatMap((out) => out.type === 'assistant' ? out.content.filter((b) => b.type === 'tool_use').map((b) => b.name) : []);
		expect(toolUses).toEqual(['mcp__ext-server__get-page', 'mcp__ext-server__delete-page']);
		expect(blocked).toEqual(['mcp__ext-server__delete-page']);
		expect(mcpCalls).toEqual(['get-page:42']);

		await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
		session.dispose();
		expect(closedMcpSessions).toBe(1);
	}, 30_000);
});
