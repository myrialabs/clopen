/**
 * Open Code Server & Client Manager
 *
 * Manages the `opencode serve` child process and provides an OpencodeClient
 * singleton for all engine instances.
 *
 * Strategy:
 * 1. Check DB for previously stored server URL → health-check → reuse if alive
 * 2. Otherwise spawn `opencode serve` via Bun.spawn (port 0, OS-assigned) and persist URL
 * 3. On every ensureClient() call, verify the server is still alive.
 *    If it died mid-session, automatically recover through the same flow.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Subprocess } from 'bun';
import { getOpenCodeMcpConfig } from '../../../mcp';
import { settingsQueries } from '../../../database/queries';
import { generateOpenCodeProviderConfig } from './config';
import { resolveBinaryWithRefresh } from '$backend/utils/cli';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

const OPENCODE_HOST = '127.0.0.1';
const DB_KEY = 'opencode.server.url';
// The isolated data dir the persisted server was spawned with. A reused server
// inherits the env it was spawned with, so if our target dir has changed (code
// update that moves the isolation path, or a server left over from before
// isolation existed) we must NOT reuse it — respawn into the right dir instead.
const DB_KEY_DATADIR = 'opencode.server.datadir';
const HEALTH_TIMEOUT = 1500;
const SERVER_START_TIMEOUT = 30_000; // 30s — generous for slow devices

let serverProc: Subprocess | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let client: OpencodeClient | null = null;
let initPromise: Promise<void> | null = null;
let ready = false;
let ownsProcess = false;

function clearClientState(): void {
	client = null;
	ready = false;
	serverHandle = null;
	serverProc = null;
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
 *
 * Race-condition guard: after any `await` (health check), we re-check
 * `initPromise` before starting a new init — another caller may have
 * already kicked one off during our async gap.
 */
export async function ensureClient(): Promise<OpencodeClient> {
	// Wait for any in-progress init first
	if (initPromise) {
		try { await initPromise; } catch { /* handled below */ }
		if (client && ready) return client;
	}

	// Fast path: server is up and healthy
	if (client && ready && serverHandle) {
		if (await isServerAlive(serverHandle.url)) return client;

		// Server disconnected — purge stale DB entry
		// Do NOT clear initPromise — another caller may have started one
		debug.log('engine', 'Open Code server disconnected, recovering...');
		settingsQueries.delete(DB_KEY);
		settingsQueries.delete(DB_KEY_DATADIR);
		clearClientState();
	}

	// Re-check after async gap — another caller may have started init
	if (initPromise) {
		try { await initPromise; } catch { /* handled below */ }
		if (client && ready) return client;
	}

	// Start init — no other caller is initializing at this point
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

	// Isolate OpenCode's state (opencode.db, snapshots, logs, config) to
	// {clopenDir}/engine/opencode/user/ instead of the shared XDG dirs
	// (~/.local/share/opencode, ~/.config/opencode) so Clopen never mixes with
	// the user's own OpenCode CLI usage. OpenCode follows the XDG base-dir spec
	// and appends `/opencode` to each base. Credentials + MCP config are injected
	// via OPENCODE_CONFIG_CONTENT, so no auth file needs to carry over.
	const opencodeUserDir = getEngineUserConfigDir('opencode');

	// 1. Try to reuse an existing server persisted in DB — but only if it was
	// spawned with the SAME isolated data dir we'd use now. A mismatch means the
	// stored server points at a stale location (pre-isolation, or a moved path);
	// reusing it would silently keep writing to the wrong dir.
	const stored = settingsQueries.get(DB_KEY);
	const storedDataDir = settingsQueries.get(DB_KEY_DATADIR)?.value;
	if (stored?.value) {
		debug.log('engine', `Found stored Open Code server: ${stored.value}, checking...`);

		if (storedDataDir === opencodeUserDir && await isServerAlive(stored.value)) {
			const { createOpencodeClient } = await import('@opencode-ai/sdk');
			client = createOpencodeClient({ baseUrl: stored.value });
			serverHandle = { url: stored.value, close() {} };
			ownsProcess = false;
			ready = true;
			debug.log('engine', `Reusing existing Open Code server at ${stored.value}`);
			return;
		}

		if (storedDataDir !== opencodeUserDir) {
			debug.log('engine', `Stored Open Code server data dir mismatch (${storedDataDir ?? 'unknown'} ≠ ${opencodeUserDir}), spawning fresh...`);
		} else {
			debug.log('engine', 'Stored server not responding, spawning new one...');
		}
		settingsQueries.delete(DB_KEY);
		settingsQueries.delete(DB_KEY_DATADIR);
	}

	// 2. Spawn a new server via Bun.spawn with absolute binary path.
	// Re-harvest PATH and fall back to known install locations so freshly
	// installed binaries are picked up without a clopen restart.
	const command = await resolveBinaryWithRefresh('opencode');
	if (!command) throw new Error('opencode binary not found on PATH');
	const args = [command, 'serve', `--hostname=${OPENCODE_HOST}`, '--port=0'];

	// Build MCP config — but only inject remote servers whose endpoint is
	// actually reachable. The opencode binary may initialize MCP connections
	// synchronously before printing "opencode server listening", so an
	// unreachable/slow remote endpoint can stall startup. Drop ONLY the
	// unreachable remote entries; stdio/local servers (no `url`) are independent
	// of the HTTP bridge and must always survive — they were previously thrown
	// out together with the bridge when it wasn't reachable yet.
	const mcpConfig = getOpenCodeMcpConfig();
	if (Object.keys(mcpConfig).length > 0) {
		const entries = Object.entries(mcpConfig);
		const reachability = await Promise.all(
			entries.map(([, c]) => {
				const url = (c as any).url as string | undefined;
				return url ? isServerAlive(url) : Promise.resolve(true);
			})
		);
		entries.forEach(([name, config], i) => {
			if (reachability[i]) {
				debug.log('engine', `Open Code server: injecting MCP server → ${name}: ${config.type} (${(config as any).url || (config as any).command?.join(' ')})`);
			} else {
				debug.warn('engine', `Open Code server: MCP endpoint for "${name}" not reachable, skipping it`);
				delete mcpConfig[name];
			}
		});
	}

	// Build provider config from DB (enabled providers + env vars)
	const providerConfig = generateOpenCodeProviderConfig();
	if (providerConfig.enabledProviders.length > 0) {
		debug.log('engine', `Open Code server: enabling ${providerConfig.enabledProviders.length} provider(s): ${providerConfig.enabledProviders.join(', ')}`);
	}
	if (Object.keys(providerConfig.envVars).length > 0) {
		debug.log('engine', `Open Code server: injecting ${Object.keys(providerConfig.envVars).length} env var(s): ${Object.keys(providerConfig.envVars).join(', ')}`);
	}

	// Merge MCP config + enabled_providers into a single OPENCODE_CONFIG_CONTENT
	const mergedConfig: Record<string, unknown> = {};
	if (Object.keys(mcpConfig).length > 0) {
		mergedConfig.mcp = mcpConfig;
	}
	if (providerConfig.enabledProviders.length > 0) {
		mergedConfig.enabled_providers = providerConfig.enabledProviders;
	}
	const configContent = Object.keys(mergedConfig).length > 0
		? JSON.stringify(mergedConfig)
		: '{}';

	debug.log('engine', `Spawning: ${args.join(' ')} (data dir: ${opencodeUserDir})`);

	const proc = Bun.spawn(args, {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			...providerConfig.envVars,
			XDG_DATA_HOME: opencodeUserDir,
			XDG_CONFIG_HOME: opencodeUserDir,
			XDG_STATE_HOME: opencodeUserDir,
			XDG_CACHE_HOME: opencodeUserDir,
			OPENCODE_CONFIG_CONTENT: configContent,
		},
	});

	// Parse server URL from stdout — opencode prints "opencode server listening on <url>"
	const url = await new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error(`Timeout waiting for opencode server to start after ${SERVER_START_TIMEOUT}ms`));
		}, SERVER_START_TIMEOUT);

		let output = '';

		const readStream = async (stream: ReadableStream<Uint8Array>, label: string) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					output += chunk;

					if (label === 'stdout') {
						for (const line of output.split('\n')) {
							if (line.startsWith('opencode server listening')) {
								const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
								if (match) {
									clearTimeout(timeout);
									resolve(match[1]);
									return;
								}
							}
						}
					}
				}
			} catch {
				// stream closed
			}
		};

		readStream(proc.stdout as ReadableStream<Uint8Array>, 'stdout');
		readStream(proc.stderr as ReadableStream<Uint8Array>, 'stderr');

		proc.exited.then((code) => {
			clearTimeout(timeout);
			let msg = `opencode server exited with code ${code}`;
			if (output.trim()) msg += `\nServer output: ${output}`;
			reject(new Error(msg));
		});
	});

	serverProc = proc;
	const { createOpencodeClient } = await import('@opencode-ai/sdk');
	client = createOpencodeClient({ baseUrl: url });
	serverHandle = {
		url,
		close() { proc.kill(); },
	};
	ownsProcess = true;
	ready = true;

	settingsQueries.set(DB_KEY, url);
	settingsQueries.set(DB_KEY_DATADIR, opencodeUserDir);
	debug.log('engine', `Open Code client ready (server: ${url}, data dir: ${opencodeUserDir})`);
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
 * @param forRestart — When true, always kills the server process (even if
 *   we didn't spawn it) and purges the stored URL so the next init() spawns
 *   a fresh server with updated config. Used by the Restart Server flow.
 *
 *   When false (default), only kills the child process when we spawned it.
 *   Reused servers stay alive so the next session can pick them up.
 */
export async function disposeOpenCodeClient(forRestart = false): Promise<void> {
	if (serverHandle) {
		if (ownsProcess || forRestart) {
			try {
				debug.log('engine', `Stopping Open Code server (${serverHandle.url}, forRestart=${forRestart})...`);
				if (ownsProcess) {
					serverHandle.close();
				} else if (forRestart) {
					// Server we didn't spawn — kill it by sending a request or just
					// purging the stored URL. The server process may be external, but
					// clearing DB ensures we spawn a new one on next init().
					try {
						await fetch(`${serverHandle.url}/shutdown`, {
							method: 'POST',
							signal: AbortSignal.timeout(2000),
						});
					} catch {
						// shutdown endpoint may not exist — that's fine
					}
				}
				settingsQueries.delete(DB_KEY);
				settingsQueries.delete(DB_KEY_DATADIR);
			} catch (error) {
				debug.error('engine', 'Error stopping Open Code server:', error);
			}
		}
	} else if (forRestart) {
		// No active handle but forRestart requested — ensure DB is clean
		settingsQueries.delete(DB_KEY);
		settingsQueries.delete(DB_KEY_DATADIR);
	}

	clearClientState();
	initPromise = null;
	debug.log('engine', 'Open Code client disposed');
}
