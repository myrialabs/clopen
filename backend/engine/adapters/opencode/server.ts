/**
 * Open Code Server & Client Pool
 *
 * Open Code runs as a persistent `opencode serve` child process that bakes its
 * MCP set and agent registry at boot. A single shared server therefore CANNOT
 * express a per-session Profile (excluded connectors/subagents leak, and the
 * registry is served stale). So instead of one server we keep a POOL keyed by a
 * config SIGNATURE — the Profile's filtered MCP set + inline agent set — and
 * route each stream to the server matching its Profile. Two sessions on the same
 * Profile share a server; different Profiles get isolated servers, concurrently.
 *
 * Strategy per key:
 * 1. Reuse the pooled server if it is still alive.
 * 2. Otherwise spawn `opencode serve` (port 0) with the key's config content and
 *    add it to the pool. Profile servers beyond a small cap are LRU-evicted.
 * 3. Health-check on every access; a dead server is dropped and respawned.
 *
 * The DEFAULT key (`*|*`, no Profile constraint) is the server used for model
 * listing and unprofiled streams. The pool is in-memory only — a Clopen restart
 * respawns servers (a legacy single-server URL persisted by older builds is
 * shut down once on first use).
 */

import { join } from 'path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Subprocess } from 'bun';
import { getOpenCodeMcpConfig } from '../../../mcp';
import { engineQueries, settingsQueries } from '../../../database/queries';
import { generateOpenCodeProviderConfig } from './config';
import type { OpenCodeInlineAgent } from '$backend/subagents';
import { resolveBinaryWithRefresh } from '$backend/utils/cli';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

const OPENCODE_HOST = '127.0.0.1';
/** Legacy single-server keys persisted by pre-pool builds — cleaned up once. */
const LEGACY_DB_KEY = 'opencode.server.url';
const LEGACY_DB_KEY_DATADIR = 'opencode.server.datadir';
const HEALTH_TIMEOUT = 1500;
const SERVER_START_TIMEOUT = 30_000; // 30s — generous for slow devices
/** Config signature for a stream with no Profile constraint. */
export const DEFAULT_SERVER_KEY = '*|*';
/** Max concurrently-pooled Profile servers (the default server is never evicted). */
const MAX_POOL_SERVERS = 4;

export interface ServerInstance {
	key: string;
	url: string;
	client: OpencodeClient;
	proc: Subprocess | null;
	ownsProcess: boolean;
	lastUsed: number;
}

/** What distinguishes one Profile's server from another. */
export interface ServerConfigSpec {
	/** Allowed MCP connector slugs (undefined = unconstrained → all enabled). */
	mcpProfileFilter?: Set<string>;
	/** Inline agent definitions (undefined/empty = the engine's default set). */
	inlineAgents?: Record<string, OpenCodeInlineAgent>;
}

const pool = new Map<string, ServerInstance>();
const initPromises = new Map<string, Promise<ServerInstance>>();
let legacyCleaned = false;

/** Short, stable FNV-1a hex hash — folds variable config (e.g. inline agent
 *  content) into a compact server-key segment so an edit spawns a fresh server. */
export function hashConfig(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

async function isServerAlive(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
		return true;
	} catch {
		return false;
	}
}

/** One-time shutdown of a server spawned by an older single-server build. */
async function cleanupLegacyServer(): Promise<void> {
	if (legacyCleaned) return;
	legacyCleaned = true;
	const stored = settingsQueries.get(LEGACY_DB_KEY)?.value;
	if (stored) {
		try {
			await fetch(`${stored}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
		} catch { /* endpoint may not exist / already dead */ }
		settingsQueries.delete(LEGACY_DB_KEY);
		settingsQueries.delete(LEGACY_DB_KEY_DATADIR);
		debug.log('engine', `Open Code: shut down legacy single-server (${stored})`);
	}
}

function killInstance(inst: ServerInstance): void {
	if (inst.ownsProcess && inst.proc) {
		try { inst.proc.kill(); } catch { /* already gone */ }
	}
}

/** Evict the least-recently-used PROFILE server when the pool is over cap. */
function evictIfNeeded(): void {
	const evictable = [...pool.values()].filter(s => s.key !== DEFAULT_SERVER_KEY);
	if (evictable.length <= MAX_POOL_SERVERS) return;
	evictable.sort((a, b) => a.lastUsed - b.lastUsed);
	for (const victim of evictable.slice(0, evictable.length - MAX_POOL_SERVERS)) {
		debug.log('engine', `Open Code: evicting idle Profile server (${victim.key}) at ${victim.url}`);
		killInstance(victim);
		pool.delete(victim.key);
	}
}

/**
 * Get (or spawn) the pooled Open Code server for a config signature. The `spec`
 * is only consulted when a server for `key` must be spawned; callers must pass a
 * `key` that uniquely captures the spec (see the adapter's signature builder).
 */
export async function ensureServer(key: string, spec: ServerConfigSpec): Promise<ServerInstance> {
	await cleanupLegacyServer();

	const existing = pool.get(key);
	if (existing) {
		if (await isServerAlive(existing.url)) {
			existing.lastUsed = Date.now();
			return existing;
		}
		killInstance(existing);
		pool.delete(key);
	}

	const inFlight = initPromises.get(key);
	if (inFlight) return inFlight;

	const p = spawnServer(key, spec)
		.then(inst => {
			pool.set(key, inst);
			evictIfNeeded();
			return inst;
		})
		.finally(() => { initPromises.delete(key); });
	initPromises.set(key, p);
	return p;
}

async function spawnServer(key: string, spec: ServerConfigSpec): Promise<ServerInstance> {
	debug.log('engine', `Spawning Open Code server for key "${key}"...`);

	// Isolate Open Code state under Clopen's dir (XDG overrides) — never mixes with
	// the user's own CLI usage. CONFIG is shared across pooled servers (commands +
	// instructions live there; agents come INLINE via OPENCODE_CONFIG_CONTENT, not
	// the on-disk agent dir). DATA/STATE/CACHE (incl. opencode.db, sessions,
	// snapshots) are per-key so concurrent Profile servers never share one SQLite
	// db. The DEFAULT server keeps the base dir for back-compat with old sessions.
	const configDir = getEngineUserConfigDir('opencode');
	const dataDir = key === DEFAULT_SERVER_KEY
		? configDir
		: join(configDir, 'pool', Buffer.from(key).toString('base64url'));

	const command = await resolveBinaryWithRefresh('opencode');
	if (!command) throw new Error('opencode binary not found on PATH');
	const args = [command, 'serve', `--hostname=${OPENCODE_HOST}`, '--port=0'];

	// MCP: only inject remote servers whose endpoint is reachable — an unreachable
	// remote can stall startup. stdio/local servers (no `url`) always survive.
	const mcpConfig = getOpenCodeMcpConfig(spec.mcpProfileFilter);
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
				debug.log('engine', `Open Code[${key}]: MCP → ${name}: ${config.type} (${(config as any).url || (config as any).command?.join(' ')})`);
			} else {
				debug.warn('engine', `Open Code[${key}]: MCP endpoint for "${name}" not reachable, skipping it`);
				delete mcpConfig[name];
			}
		});
	}

	const providerConfig = generateOpenCodeProviderConfig();

	// Merge MCP + providers + inline agents into a single OPENCODE_CONFIG_CONTENT.
	const mergedConfig: Record<string, unknown> = {};
	if (Object.keys(mcpConfig).length > 0) mergedConfig.mcp = mcpConfig;
	if (providerConfig.enabledProviders.length > 0) mergedConfig.enabled_providers = providerConfig.enabledProviders;
	if (spec.inlineAgents && Object.keys(spec.inlineAgents).length > 0) mergedConfig.agent = spec.inlineAgents;

	// Inject provider definitions for custom OpenAI-compatible providers
	// (those with api_url set). Unlike models.dev catalog providers, custom
	// providers need their npm + baseURL passed explicitly so the opencode
	// server can discover models from their /v1/models endpoint.
	const providerSection: Record<string, unknown> = {};
	const opencodeProviders = engineQueries.getEnabledProviders('opencode');
	for (const provider of opencodeProviders) {
		if (!provider.api_url) continue;

		const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
		let defaultContext = 128000;
		let defaultOutput = 16384;
		let modelNames: Record<string, string> = {};
		let hiddenSet = new Set<string>();
		try {
			const opts = JSON.parse(provider.options || '{}') as {
				models?: string[];
				modelNames?: Record<string, string>;
				hiddenModels?: string[];
				contextLimit?: number;
				outputLimit?: number;
			};
			if (opts.contextLimit) defaultContext = opts.contextLimit;
			if (opts.outputLimit) defaultOutput = opts.outputLimit;
			if (opts.modelNames) modelNames = opts.modelNames;
			if (opts.hiddenModels) hiddenSet = new Set(opts.hiddenModels);
		} catch {
			// malformed options — proceed to auto-discover
		}

		const addModel = (id: string) => {
			models[id] = { name: modelNames[id] || id, limit: { context: defaultContext, output: defaultOutput } };
		};

		try {
			const opts = JSON.parse(provider.options || '{}') as { models?: string[] };
			if (opts.models && opts.models.length > 0) {
				for (const id of opts.models) {
					if (!hiddenSet.has(id)) addModel(id);
				}
			}
		} catch {
			// malformed options — proceed to auto-discover
		}

		// Auto-discover models from /v1/models if none stored in options
		if (Object.keys(models).length === 0) {
			try {
				const baseUrl = provider.api_url.replace(/\/+$/, '');
				const res = await fetch(`${baseUrl}/models`, {
					signal: AbortSignal.timeout(3000),
				});
				if (res.ok) {
					const body = await res.json() as { data?: { id: string }[] };
					for (const m of body.data ?? []) {
						addModel(m.id);
					}
				}
			} catch {
				// Provider may not be running — models will be empty.
			}
		}

		let modelOrder: string[] | undefined;
		try {
			const o = JSON.parse(provider.options || '{}') as { models?: string[] };
			if (o.models && o.models.length > 0) modelOrder = o.models.filter(id => !hiddenSet.has(id));
		} catch { /* ignore */ }
		const providerOptions: Record<string, unknown> = { baseURL: provider.api_url };
		if (modelOrder) providerOptions._modelOrder = modelOrder;
		providerSection[provider.slug] = {
			npm: provider.npm || '@ai-sdk/openai-compatible',
			name: provider.name,
			options: providerOptions,
			models: models,
		};
	}
	if (Object.keys(providerSection).length > 0) mergedConfig.provider = providerSection;

	const configContent = Object.keys(mergedConfig).length > 0 ? JSON.stringify(mergedConfig) : '{}';

	const proc = Bun.spawn(args, {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			...providerConfig.envVars,
			XDG_CONFIG_HOME: configDir,
			XDG_DATA_HOME: dataDir,
			XDG_STATE_HOME: dataDir,
			XDG_CACHE_HOME: dataDir,
			OPENCODE_CONFIG_CONTENT: configContent,
		},
	});

	// Parse the URL from "opencode server listening on <url>".
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
					output += decoder.decode(value, { stream: true });
					if (label === 'stdout') {
						for (const line of output.split('\n')) {
							if (line.startsWith('opencode server listening')) {
								const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
								if (match) { clearTimeout(timeout); resolve(match[1]); return; }
							}
						}
					}
				}
			} catch { /* stream closed */ }
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

	const { createOpencodeClient } = await import('@opencode-ai/sdk');
	const client = createOpencodeClient({ baseUrl: url });
	debug.log('engine', `Open Code server ready (key "${key}", ${url}, data dir: ${dataDir})`);
	return { key, url, client, proc, ownsProcess: true, lastUsed: Date.now() };
}

/**
 * The DEFAULT (no-Profile) client — used for model listing, one-shot structured
 * generation, and warm-up. Concurrency-safe via the shared init promise.
 */
export async function ensureClient(): Promise<OpencodeClient> {
	return (await ensureServer(DEFAULT_SERVER_KEY, {})).client;
}

/** The DEFAULT server's client, if up (back-compat for callers with no stream context). */
export function getClient(): OpencodeClient | null {
	return pool.get(DEFAULT_SERVER_KEY)?.client ?? null;
}

/** The DEFAULT server's URL, if up. */
export function getServerUrl(): string | null {
	return pool.get(DEFAULT_SERVER_KEY)?.url ?? null;
}

/**
 * Dispose the whole pool. `forRestart` is accepted for signature compatibility
 * with the previous single-server API; every pooled server we own is killed
 * either way (there is no external-server-reuse path anymore).
 */
export async function disposeOpenCodeClient(_forRestart = false): Promise<void> {
	for (const inst of pool.values()) killInstance(inst);
	pool.clear();
	initPromises.clear();
	settingsQueries.delete(LEGACY_DB_KEY);
	settingsQueries.delete(LEGACY_DB_KEY_DATADIR);
	debug.log('engine', 'Open Code pool disposed');
}
