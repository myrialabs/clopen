/**
 * Open Code Server & Client Manager
 *
 * Manages the `opencode serve` child process and provides an OpencodeClient
 * singleton for all engine instances.
 *
 * Strategy:
 * 1. Check DB for previously stored server URL → health-check → reuse if alive
 * 2. Otherwise spawn `opencode serve` with port 0 (OS-assigned) and persist URL
 * 3. On every ensureClient() call, verify the server is still alive.
 *    If it died mid-session, automatically recover through the same flow.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { getOpenCodeMcpConfig } from '../../../mcp';
import { settingsQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';

const OPENCODE_HOST = '127.0.0.1';
const DB_KEY = 'opencode.server.url';
const HEALTH_TIMEOUT = 1500;

let serverHandle: { url: string; close(): void } | null = null;
let client: OpencodeClient | null = null;
let initPromise: Promise<void> | null = null;
let ready = false;
let ownsProcess = false;

function resetState(): void {
	client = null;
	ready = false;
	initPromise = null;
	serverHandle = null;
	ownsProcess = false;
}

async function isServerAlive(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get (or create) the OpenCode client.
 * Concurrency-safe: multiple callers share a single init promise.
 *
 * When the server is already initialized, a lightweight health check runs.
 * If the server died (bun --watch restart, crash, etc.), state is reset and
 * init() is re-invoked — the same DB-check → reuse-or-spawn flow handles
 * recovery automatically.
 */
export async function ensureClient(): Promise<OpencodeClient> {
	if (client && ready && serverHandle) {
		if (await isServerAlive(serverHandle.url)) return client;

		// Server disconnected — purge stale DB entry and re-init
		debug.log('engine', 'Open Code server disconnected, recovering...');
		settingsQueries.delete(DB_KEY);
		resetState();
	}

	if (initPromise) {
		await initPromise;
		return client!;
	}

	initPromise = init();
	try {
		await initPromise;
		return client!;
	} catch (error) {
		initPromise = null;
		throw error;
	}
}

async function init(): Promise<void> {
	debug.log('engine', 'Initializing Open Code client...');

	// 1. Try to reuse an existing server persisted in DB
	const stored = settingsQueries.get(DB_KEY);
	if (stored?.value) {
		debug.log('engine', `Found stored Open Code server: ${stored.value}, checking...`);

		if (await isServerAlive(stored.value)) {
			const { createOpencodeClient } = await import('@opencode-ai/sdk');
			client = createOpencodeClient({ baseUrl: stored.value });
			serverHandle = { url: stored.value, close() {} };
			ownsProcess = false;
			ready = true;
			debug.log('engine', `Reusing existing Open Code server at ${stored.value}`);
			return;
		}

		debug.log('engine', 'Stored server not responding, spawning new one...');
		settingsQueries.delete(DB_KEY);
	}

	// 2. Spawn a new server — port 0 lets opencode pick an OS-assigned port
	const { createOpencode } = await import('@opencode-ai/sdk');

	const mcpConfig = getOpenCodeMcpConfig();
	if (Object.keys(mcpConfig).length > 0) {
		debug.log('engine', `Open Code server: injecting ${Object.keys(mcpConfig).length} MCP server(s)`);
		for (const [name, config] of Object.entries(mcpConfig)) {
			debug.log('engine', `  → ${name}: ${config.type} (${(config as any).url || (config as any).command?.join(' ')})`);
		}
	}

	const result = await createOpencode({
		hostname: OPENCODE_HOST,
		port: 0,
		...(Object.keys(mcpConfig).length > 0 && {
			config: { mcp: mcpConfig },
		}),
	});

	serverHandle = result.server;
	client = result.client;
	ownsProcess = true;
	ready = true;

	settingsQueries.set(DB_KEY, result.server.url);
	debug.log('engine', `Open Code client ready (server: ${result.server.url})`);
}

export function getClient(): OpencodeClient | null {
	return ready ? client : null;
}

export function getServerUrl(): string | null {
	return serverHandle?.url ?? null;
}

/**
 * Dispose the OpenCode client and stop the server.
 *
 * Only kills the child process when we spawned it. Reused servers stay alive
 * so the next session can pick them up without spawning a new process.
 */
export async function disposeOpenCodeClient(): Promise<void> {
	if (serverHandle && ownsProcess) {
		try {
			debug.log('engine', `Stopping Open Code server (${serverHandle.url})...`);
			serverHandle.close();
			settingsQueries.delete(DB_KEY);
		} catch (error) {
			debug.error('engine', 'Error stopping Open Code server:', error);
		}
	}

	resetState();
	debug.log('engine', 'Open Code client disposed');
}
