/**
 * Open Code Server & Client Pool
 *
 * Open Code runs as a persistent `opencode serve` child process that bakes its
 * MCP set, provider list and agent registry at boot. Nothing it reads at start-up
 * can be changed in place, so the pool keeps one server per CONFIG SIGNATURE and
 * routes each stream to the server matching the config it needs.
 *
 * The signature is a hash of the bytes we are about to hand the process —
 * `OPENCODE_CONFIG_CONTENT`, the provider env vars, and a fingerprint of the
 * on-disk artifact files it reads at boot. That is the whole point: the key is
 * derived from the config itself rather than from a hand-maintained list of
 * "things that need a restart". A field added to the spawn config three features
 * from now is covered without anybody remembering that this file exists, and a
 * change that turns out not to alter any baked byte (toggling a connector off and
 * back on, editing a permission rule that is enforced per-prompt) produces the
 * same hash and reuses the running server.
 *
 * This replaced a "Restart Server" button. The button was the only thing that
 * made a config edit take effect, which meant the product worked correctly only
 * for users who knew the button existed. Everything below exists so that nobody
 * has to know.
 *
 * ── Two keys, not one ───────────────────────────────────────────────────────
 * `scopeKey` decides WHERE SESSION DATA LIVES (the XDG data dir holding
 * opencode.db). `poolKey` decides WHICH PROCESS serves a stream. They are
 * separate because conflating them loses conversations: session resume works by
 * forking an opencode session id, so if the data dir moved every time a setting
 * changed, every in-progress chat would silently lose its engine-side history the
 * next time the user edited anything. The scope is the Profile's shape — the set
 * of connectors and subagents — which is also the isolation boundary that made
 * per-scope dirs necessary in the first place.
 *
 * A consequence is that two processes can briefly share one data dir while an old
 * server drains. Open Code stores sessions in WAL-mode SQLite and keeps a `locks/`
 * directory for exactly this, and running its CLI alongside a server on one XDG
 * home is its normal mode of operation.
 *
 * ── Draining, not killing ───────────────────────────────────────────────────
 * A server is never killed while a stream holds it. Each stream registers itself
 * as a holder for as long as it runs — including while it sits waiting on an
 * AskUserQuestion, which is idle but very much alive. A server whose config is no
 * longer current dies the moment its last holder leaves; a current one dies after
 * sitting unused for `IDLE_TTL_MS`.
 *
 * There is deliberately NO cap on the pool. A cap can only be enforced by killing
 * a server, and the servers it would reach for during a burst are the ones being
 * used — trading a bounded number of processes for broken chats. Idle servers are
 * already reaped, so the count settles on its own.
 */

import { join } from 'path';
import { readdir, rename, stat } from 'fs/promises';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Subprocess } from 'bun';
import { getOpenCodeMcpConfig } from '../../../mcp';
import { engineQueries, settingsQueries } from '../../../database/queries';
import { generateOpenCodeProviderConfig, parseCredentialMap } from './config';
import type { OpenCodeInlineAgent } from '$backend/subagents';
import { resolveEngineCli } from '$backend/engine/engine-cli';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { getEngineConfigRevision } from '$backend/engine/config-revision';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

const OPENCODE_HOST = '127.0.0.1';
/** Legacy single-server keys persisted by pre-pool builds — cleaned up once. */
const LEGACY_DB_KEY = 'opencode.server.url';
const LEGACY_DB_KEY_DATADIR = 'opencode.server.datadir';
const HEALTH_TIMEOUT = 1500;
const SERVER_START_TIMEOUT = 30_000; // 30s — generous for slow devices
/**
 * Session-data scope for a stream with no Profile constraint.
 *
 * Must be exactly what `scopeKeyFor({})` produces — model listing, warm-up and
 * unprofiled streams all have to land on the same scope, and a constant that
 * merely looked like the default would silently match nothing.
 */
export const DEFAULT_SCOPE_KEY = 'mcp:*|agents:*';
/** How long an unused, still-current server is kept before being reaped. */
const IDLE_TTL_MS = 30 * 60_000;
/**
 * Grace period after last use during which a server is never reaped.
 *
 * Not every use registers a holder — model listing and one-shot structured
 * generation borrow a client for a second and hand it back. Rather than thread a
 * holder token through those call sites, the reaper simply leaves recently-touched
 * servers alone. Worst case a superseded server lives ten seconds longer.
 */
const REAP_GRACE_MS = 10_000;

export interface ServerInstance {
	/** Config signature — identifies the PROCESS. */
	key: string;
	/** Profile shape — identifies the DATA DIR, and is stable across config edits. */
	scopeKey: string;
	url: string;
	client: OpencodeClient;
	proc: Subprocess | null;
	ownsProcess: boolean;
	lastUsed: number;
	/** Stream ids currently bound to this server. Non-empty ⇒ never reaped. */
	holders: Set<string>;
}

/** What distinguishes one Profile's server from another. */
export interface ServerConfigSpec {
	/** Allowed MCP connector slugs (undefined = unconstrained → all enabled). */
	mcpProfileFilter?: Set<string>;
	/** Subagent slugs the active Profile narrows to (undefined = unconstrained). */
	subagentFilter?: Set<string>;
	/** Inline agent definitions (undefined/empty = the engine's default set). */
	inlineAgents?: Record<string, OpenCodeInlineAgent>;
}

/** Everything needed to spawn a server, plus the key derived from it. */
interface SpawnPlan {
	key: string;
	scopeKey: string;
	configContent: string;
	envVars: Record<string, string>;
}

/**
 * The expensive half of a plan — cached until the config revision moves.
 *
 * Holds only what costs a network round-trip to determine: which MCP endpoints
 * answered, and which models a custom provider advertises. Everything cheap is
 * assembled per call, so nothing that can change without the database noticing
 * gets to hide behind this cache.
 */
interface CachedConfig {
	revision: number;
	mcpConfig: Record<string, unknown>;
	enabledProviders: string[];
	providerSection: Record<string, unknown>;
	envVars: Record<string, string>;
}

const pool = new Map<string, ServerInstance>();
const initPromises = new Map<string, Promise<ServerInstance>>();
/** scopeKey → the poolKey that scope should currently be served by. */
const currentKeyByScope = new Map<string, string>();
const configCache = new Map<string, CachedConfig>();
const adoptedScopes = new Set<string>();
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

// ============================================================================
// Keys
// ============================================================================

/**
 * The session-data scope for a spec: what the active Profile CONSTRAINS, and
 * nothing else.
 *
 * Only the Profile's filters go in — never the artifacts they resolve to, and
 * never those artifacts' content. Both alternatives move the data dir for things
 * that are not a change of isolation boundary: keying on the resolved agent set
 * would relocate every conversation the moment a subagent is added globally, and
 * keying on the agents' content (which the previous scheme did, by folding a
 * content hash into the dir name) relocated them on every prompt edit. A
 * relocated data dir means `session.fork` cannot find the session id and the
 * chat silently loses its engine-side history.
 */
function scopeKeyFor(spec: ServerConfigSpec): string {
	const mcpKey = spec.mcpProfileFilter ? [...spec.mcpProfileFilter].sort().join(',') : '*';
	const agentKey = spec.subagentFilter ? [...spec.subagentFilter].sort().join(',') : '*';
	return `mcp:${mcpKey}|agents:${agentKey}`;
}

/**
 * Session data dir for a scope.
 *
 * Every scope — including the unconstrained one — gets its own directory under
 * `pool/`, so concurrent Profile servers never share a SQLite store. The base
 * config dir stays XDG_CONFIG_HOME (commands, AGENTS.md), which is shared by
 * design and holds no session state.
 */
function dataDirForScope(scopeKey: string): string {
	return join(getEngineUserConfigDir('opencode'), 'pool', Buffer.from(scopeKey).toString('base64url'));
}

/**
 * Fingerprint of the artifact files Open Code reads at boot.
 *
 * Commands, subagent files and the AGENTS.md instruction block are written to
 * disk by the per-stream artifact sync, so their CONTENT never appears in the DB
 * and the config revision cannot see it change. Size + mtime is enough to notice
 * an edit and costs three stats. Missing paths contribute a stable marker rather
 * than throwing — an engine with no commands yet is the normal case.
 */
async function artifactFingerprint(): Promise<string> {
	const base = join(getEngineUserConfigDir('opencode'), 'opencode');
	const targets = [join(base, 'command'), join(base, 'agent'), join(base, 'AGENTS.md')];
	const parts: string[] = [];

	for (const path of targets) {
		try {
			const info = await stat(path);
			if (info.isDirectory()) {
				const names = (await readdir(path)).sort();
				const entries = await Promise.all(names.map(async name => {
					try {
						const child = await stat(join(path, name));
						return `${name}:${child.size}:${Math.floor(child.mtimeMs)}`;
					} catch {
						return `${name}:gone`;
					}
				}));
				parts.push(`${path}[${entries.join('|')}]`);
			} else {
				parts.push(`${path}:${info.size}:${Math.floor(info.mtimeMs)}`);
			}
		} catch {
			parts.push(`${path}:absent`);
		}
	}

	return hashConfig(parts.join('\n'));
}

// ============================================================================
// Config building
// ============================================================================

/**
 * Build the provider section for custom OpenAI-compatible providers.
 *
 * Unlike models.dev catalog providers, these need their npm package and baseURL
 * passed explicitly so the server can discover models from `/v1/models`.
 */
async function buildProviderSection(): Promise<Record<string, unknown>> {
	const providerSection: Record<string, unknown> = {};
	const opencodeProviders = engineQueries.getEnabledProviders('opencode');

	for (const provider of opencodeProviders) {
		if (!provider.api_url) continue;

		// Resolve the active account's credential so we can (a) authenticate the
		// endpoint and (b) substitute `${VAR}` placeholders in the base URL.
		// Multi-secret providers (e.g. Cloudflare Workers AI, whose URL embeds
		// ${CLOUDFLARE_ACCOUNT_ID} and whose bearer is CLOUDFLARE_API_KEY) store
		// every secret as a JSON bundle; single-key providers store a raw string.
		const activeAccount = engineQueries.getActiveAccount(provider.id);
		let baseURL = provider.api_url;
		let apiKey: string | undefined;
		if (activeAccount?.credential) {
			const credMap = parseCredentialMap(activeAccount.credential);
			if (credMap) {
				baseURL = baseURL.replace(/\$\{(\w+)\}/g, (_m, name) => credMap[name] ?? '');
				const keys = Object.keys(credMap);
				const tokenKey = keys.find(k => /API[_-]?(?:KEY|TOKEN)$/i.test(k)) ?? keys.find(k => /(?:KEY|TOKEN)$/i.test(k));
				if (tokenKey) apiKey = credMap[tokenKey];
			} else {
				apiKey = activeAccount.credential;
			}
		}

		const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
		// Per-model limits live in `modelLimits`; legacy provider-level
		// contextLimit/outputLimit remain a fallback for older rows.
		let defaultContext = 128000;
		let defaultOutput = 16384;
		let modelLimits: Record<string, { context?: number; output?: number }> = {};
		let modelNames: Record<string, string> = {};
		let hiddenSet = new Set<string>();
		let storedModels: string[] = [];
		try {
			const opts = JSON.parse(provider.options || '{}') as {
				models?: string[];
				modelNames?: Record<string, string>;
				hiddenModels?: string[];
				modelLimits?: Record<string, { context?: number; output?: number }>;
				contextLimit?: number;
				outputLimit?: number;
			};
			if (opts.contextLimit) defaultContext = opts.contextLimit;
			if (opts.outputLimit) defaultOutput = opts.outputLimit;
			if (opts.modelLimits) modelLimits = opts.modelLimits;
			if (opts.modelNames) modelNames = opts.modelNames;
			if (opts.hiddenModels) hiddenSet = new Set(opts.hiddenModels);
			if (opts.models) storedModels = opts.models;
		} catch {
			// malformed options — proceed to auto-discover
		}

		const addModel = (id: string) => {
			const lim = modelLimits[id];
			models[id] = { name: modelNames[id] || id, limit: { context: lim?.context || defaultContext, output: lim?.output || defaultOutput } };
		};

		for (const id of storedModels) {
			if (!hiddenSet.has(id)) addModel(id);
		}

		// Auto-discover models from /v1/models if none stored in options
		if (Object.keys(models).length === 0) {
			try {
				const baseUrl = baseURL.replace(/\/+$/, '');
				const res = await fetch(`${baseUrl}/models`, {
					headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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

		const modelOrder = storedModels.length > 0 ? storedModels.filter(id => !hiddenSet.has(id)) : undefined;
		const providerOptions: Record<string, unknown> = { baseURL };
		if (apiKey) providerOptions.apiKey = apiKey;
		if (modelOrder) providerOptions._modelOrder = modelOrder;
		providerSection[provider.slug] = {
			npm: provider.npm || '@ai-sdk/openai-compatible',
			name: provider.name,
			options: providerOptions,
			models: models,
		};
	}

	return providerSection;
}

/**
 * Assemble the exact config content and env a server for `spec` would be spawned
 * with. Cached per (config revision, scope) because it makes network calls —
 * reachability probes and model discovery — that must not run on every turn.
 */
async function resolveConfig(spec: ServerConfigSpec, scopeKey: string): Promise<CachedConfig> {
	const revision = getEngineConfigRevision();
	const cached = configCache.get(scopeKey);
	if (cached && cached.revision === revision) return cached;

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
				debug.log('engine', `Open Code[${scopeKey}]: MCP → ${name}: ${config.type} (${(config as any).url || (config as any).command?.join(' ')})`);
			} else {
				debug.warn('engine', `Open Code[${scopeKey}]: MCP endpoint for "${name}" not reachable, skipping it`);
				delete mcpConfig[name];
			}
		});
	}

	const providerConfig = generateOpenCodeProviderConfig();

	const resolved: CachedConfig = {
		revision,
		mcpConfig,
		enabledProviders: providerConfig.enabledProviders,
		providerSection: await buildProviderSection(),
		envVars: providerConfig.envVars,
	};
	configCache.set(scopeKey, resolved);
	return resolved;
}

/**
 * Assemble the exact `OPENCODE_CONFIG_CONTENT` for a spawn.
 *
 * The inline agents are folded in HERE rather than inside the cached half, and
 * that placement is load-bearing. A subagent's prompt lives in the canonical
 * store on disk, not in the `subagents` table, so editing it changes no database
 * row and moves no revision — and because Open Code receives agents inline, it
 * also touches none of the files the artifact fingerprint watches. Caching a
 * config that already contained the agents would therefore serve the old prompt
 * indefinitely. `buildOpenCodeInlineAgents` reads that store fresh at every
 * stream start, so folding its result in at assembly time makes the edit reach
 * the signature the way any other config change does.
 */
function assembleConfigContent(cached: CachedConfig, inlineAgents?: Record<string, OpenCodeInlineAgent>): string {
	const mergedConfig: Record<string, unknown> = {};
	if (Object.keys(cached.mcpConfig).length > 0) mergedConfig.mcp = cached.mcpConfig;
	if (cached.enabledProviders.length > 0) mergedConfig.enabled_providers = cached.enabledProviders;
	if (inlineAgents && Object.keys(inlineAgents).length > 0) mergedConfig.agent = inlineAgents;
	if (Object.keys(cached.providerSection).length > 0) mergedConfig.provider = cached.providerSection;
	return Object.keys(mergedConfig).length > 0 ? JSON.stringify(mergedConfig) : '{}';
}

/**
 * The plan for `spec` right now, including the key that identifies its process.
 *
 * Also records the scope's current key, which is what makes a superseded server
 * reapable: the reaper does not need to be told a config changed, it only needs
 * to see that a pooled server's key is no longer the one its scope resolves to.
 */
async function resolvePlan(spec: ServerConfigSpec): Promise<SpawnPlan> {
	const scopeKey = scopeKeyFor(spec);
	const [config, fingerprint] = await Promise.all([resolveConfig(spec, scopeKey), artifactFingerprint()]);
	const configContent = assembleConfigContent(config, spec.inlineAgents);
	const signature = hashConfig(`${configContent}‖${JSON.stringify(config.envVars)}‖${fingerprint}`);
	const key = `${scopeKey}#${signature}`;

	currentKeyByScope.set(scopeKey, key);
	return { key, scopeKey, configContent, envVars: config.envVars };
}

// ============================================================================
// Reaping
// ============================================================================

/**
 * Kill servers nothing needs any more.
 *
 * Superseded servers go as soon as they are unheld; current ones go after
 * sitting idle. A held server is never touched, whatever its age — a chat
 * blocked on an AskUserQuestion for ten minutes is a live conversation, not an
 * idle process.
 */
function reap(reason: string): void {
	const now = Date.now();
	for (const inst of [...pool.values()]) {
		if (inst.holders.size > 0) continue;
		if (now - inst.lastUsed < REAP_GRACE_MS) continue;

		const current = currentKeyByScope.get(inst.scopeKey);
		const superseded = current !== undefined && current !== inst.key;
		const expired = now - inst.lastUsed > IDLE_TTL_MS;
		if (!superseded && !expired) continue;

		debug.log('engine', `Open Code: reaping ${superseded ? 'superseded' : 'idle'} server ${inst.url} (${inst.key}) — ${reason}`);
		killInstance(inst);
		pool.delete(inst.key);
	}
}

/**
 * Drop holders that no longer correspond to a live stream.
 *
 * Holder bookkeeping is a `finally` away from being correct, and a `finally` is
 * one uncaught teardown path away from leaking a holder forever — which, with no
 * restart button left, would strand a superseded server permanently. The live
 * stream set is the authority; this reconciles against it. Same shape as the
 * orphan sweep the MCP tab locks use.
 */
export function reconcileServerHolders(liveStreamIds: Set<string>): void {
	let dropped = 0;
	for (const inst of pool.values()) {
		for (const holder of [...inst.holders]) {
			if (!liveStreamIds.has(holder)) {
				inst.holders.delete(holder);
				dropped++;
			}
		}
	}
	if (dropped > 0) debug.log('engine', `Open Code: released ${dropped} orphaned server holder(s)`);
	reap('holder reconciliation');
}

// ============================================================================
// Pool access
// ============================================================================

/**
 * One-time adoption of a data dir written by the previous key scheme.
 *
 * The old scheme folded the inline agents' content hash into the dir name, so an
 * upgrade would otherwise point a scope at an empty directory and every existing
 * conversation under it would fail to resume. The old name is this scope's key
 * plus `:<hash>`, so the directory is findable; the newest match wins.
 */
async function adoptLegacyScopeDir(scopeKey: string, dataDir: string): Promise<void> {
	if (adoptedScopes.has(scopeKey)) return;
	adoptedScopes.add(scopeKey);

	try {
		await stat(dataDir);
		return; // Already populated — nothing to adopt.
	} catch { /* fall through */ }

	const poolRoot = join(getEngineUserConfigDir('opencode'), 'pool');
	let candidates: string[];
	try {
		candidates = await readdir(poolRoot);
	} catch {
		return; // No pool dir yet — fresh install.
	}

	let newest: { path: string; mtime: number } | null = null;
	for (const name of candidates) {
		let decoded: string;
		try {
			decoded = Buffer.from(name, 'base64url').toString();
		} catch {
			continue;
		}
		if (!decoded.startsWith(`${scopeKey}:`)) continue;
		try {
			const info = await stat(join(poolRoot, name));
			if (!newest || info.mtimeMs > newest.mtime) newest = { path: join(poolRoot, name), mtime: info.mtimeMs };
		} catch { /* raced away */ }
	}

	if (!newest) return;
	try {
		await rename(newest.path, dataDir);
		debug.log('engine', `Open Code: adopted legacy session dir for scope "${scopeKey}"`);
	} catch (error) {
		debug.warn('engine', `Open Code: could not adopt legacy session dir for "${scopeKey}"`, error);
	}
}

/**
 * Get (or spawn) the server matching `spec`'s current config.
 *
 * `holderId` — the stream id — pins the returned server for as long as that
 * stream runs. Pass `undefined` for a borrow (model listing, warm-up); the
 * reaper's grace window covers those.
 */
export async function acquireServer(spec: ServerConfigSpec, holderId?: string): Promise<ServerInstance> {
	await cleanupLegacyServer();

	const plan = await resolvePlan(spec);
	const existing = pool.get(plan.key);
	if (existing) {
		if (await isServerAlive(existing.url)) {
			existing.lastUsed = Date.now();
			if (holderId) existing.holders.add(holderId);
			reap('server reuse');
			return existing;
		}
		killInstance(existing);
		pool.delete(plan.key);
	}

	const inFlight = initPromises.get(plan.key);
	if (inFlight) {
		const inst = await inFlight;
		if (holderId) inst.holders.add(holderId);
		return inst;
	}

	const p = spawnServer(plan)
		.then(inst => {
			pool.set(plan.key, inst);
			// Only now that a healthy replacement exists is the old one expendable.
			// Spawning before killing means a config that cannot start leaves the
			// user with the previous working server rather than with nothing.
			reap('new server ready');
			return inst;
		})
		.finally(() => { initPromises.delete(plan.key); });
	initPromises.set(plan.key, p);

	const inst = await p;
	if (holderId) inst.holders.add(holderId);
	return inst;
}

/** Release a stream's hold, and reap anything that became expendable. */
export function releaseServer(key: string, holderId: string): void {
	const inst = pool.get(key);
	if (!inst) return;
	inst.holders.delete(holderId);
	inst.lastUsed = Date.now();
	reap('holder released');
}

async function spawnServer(plan: SpawnPlan): Promise<ServerInstance> {
	debug.log('engine', `Spawning Open Code server for key "${plan.key}"...`);

	// Isolate Open Code state under Clopen's dir (XDG overrides) — never mixes with
	// the user's own CLI usage. CONFIG is shared across pooled servers (commands +
	// instructions live there; agents come INLINE via OPENCODE_CONFIG_CONTENT, not
	// the on-disk agent dir). DATA/STATE/CACHE (incl. opencode.db, sessions,
	// snapshots) follow the SCOPE, not the config signature, so a settings change
	// never moves a running conversation's session store.
	const configDir = getEngineUserConfigDir('opencode');
	const dataDir = dataDirForScope(plan.scopeKey);
	await adoptLegacyScopeDir(plan.scopeKey, dataDir);

	// The CLI lives in clopen's managed stack dir (or, failing that, on the
	// user's PATH); `resolveEngineCli` is the same lookup Settings → Stack
	// reports, so an engine shown as installed is always one we can spawn.
	// The literal "Settings → Stack" routes the chat/model-picker error to the
	// one place that fixes it.
	const cli = await resolveEngineCli('opencode');
	if (!cli) {
		throw new Error(
			'Open Code is missing its CLI. Open Settings → Stack to install it before using this engine.'
		);
	}
	const args = [cli.path, 'serve', `--hostname=${OPENCODE_HOST}`, '--port=0'];

	const proc = Bun.spawn(args, {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			...plan.envVars,
			XDG_CONFIG_HOME: configDir,
			XDG_DATA_HOME: dataDir,
			XDG_STATE_HOME: dataDir,
			XDG_CACHE_HOME: dataDir,
			OPENCODE_CONFIG_CONTENT: plan.configContent,
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

	const { createOpencodeClient } = await loadEngineSdk<typeof import('@opencode-ai/sdk')>('opencode', '@opencode-ai/sdk');
	const client = createOpencodeClient({ baseUrl: url });
	debug.log('engine', `Open Code server ready (key "${plan.key}", ${url}, data dir: ${dataDir})`);
	return {
		key: plan.key,
		scopeKey: plan.scopeKey,
		url,
		client,
		proc,
		ownsProcess: true,
		lastUsed: Date.now(),
		holders: new Set<string>(),
	};
}

/**
 * Bring every pooled scope up to date with the current config.
 *
 * Called after a config change settles and no stream is running: the replacement
 * is spawned and verified now, so the user's next message does not pay for it.
 * When streams ARE running this is skipped entirely — the next stream to start
 * resolves the new key on its own, and the running ones keep the server they
 * were bound to. A failure here is logged and nothing else: the existing server
 * stays in the pool, and the real error surfaces in chat when a turn actually
 * needs the config that cannot start.
 */
export async function refreshPool(specForScope: Map<string, ServerConfigSpec>): Promise<void> {
	for (const [scopeKey, spec] of specForScope) {
		try {
			await acquireServer(spec);
		} catch (error) {
			debug.warn('engine', `Open Code: warm-up for scope "${scopeKey}" failed; keeping the current server`, error);
		}
	}
	reap('post warm-up');
}

/** The scopes currently backed by a pooled server, for warm-up. */
export function pooledScopeKeys(): string[] {
	return [...new Set([...pool.values()].map(s => s.scopeKey))];
}

/**
 * The DEFAULT (no-Profile) client — used for model listing, one-shot structured
 * generation, and warm-up. Concurrency-safe via the shared init promise.
 */
export async function ensureClient(): Promise<OpencodeClient> {
	return (await acquireServer({})).client;
}

/** The DEFAULT server's client, if up (back-compat for callers with no stream context). */
export function getClient(): OpencodeClient | null {
	const inst = defaultInstance();
	if (inst) inst.lastUsed = Date.now();
	return inst?.client ?? null;
}

/** The DEFAULT server's URL, if up. */
export function getServerUrl(): string | null {
	const inst = defaultInstance();
	if (inst) inst.lastUsed = Date.now();
	return inst?.url ?? null;
}

function defaultInstance(): ServerInstance | undefined {
	const key = currentKeyByScope.get(DEFAULT_SCOPE_KEY);
	if (key) {
		const exact = pool.get(key);
		if (exact) return exact;
	}
	// The current key is unknown until a config has been resolved once; fall back
	// to any server on the default scope rather than reporting nothing.
	return [...pool.values()].find(s => s.scopeKey === DEFAULT_SCOPE_KEY);
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
	currentKeyByScope.clear();
	configCache.clear();
	settingsQueries.delete(LEGACY_DB_KEY);
	settingsQueries.delete(LEGACY_DB_KEY_DATADIR);
	debug.log('engine', 'Open Code pool disposed');
}
