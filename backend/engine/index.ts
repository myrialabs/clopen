/**
 * Engine Registry & Factory
 *
 * Central management of AI engine instances.
 *
 * Two tiers:
 * - Global singletons (getEngine / initializeEngine):
 *   Used for non-streaming operations like models:list, settings, etc.
 *
 * - Per-project instances (getProjectEngine / initializeProjectEngine):
 *   Used by stream-manager for chat streaming. Cancelling Project A's stream
 *   never affects Project B.
 *
 *   Per project, NOT per chat session: every chat session of a project shares
 *   one instance, and several of them stream at once. Isolation between those
 *   streams is the adapter's job, not this cache's — each keeps its per-stream
 *   state in an `EngineRuns` registry (backend/engine/adapters/run-registry.ts)
 *   and `cancel(owner)` stops exactly the run it was handed. Adding per-stream
 *   state to an adapter INSTANCE reintroduces "Stop this chat" stopping a
 *   different one.
 *
 * Adapters are loaded on first use, never at boot. This registry used to import
 * all eight statically, which coupled every user's startup to every adapter: one
 * adapter failing to load — an SDK that isn't installed, a bad module-level
 * expression — took down the whole backend, including for someone who only ever
 * uses Claude. Loading per engine keeps that failure where it belongs, on the
 * engine being asked for, and the existing pre-stream readiness check
 * (`checkEngineSetup`) turns it into an actionable chat error.
 *
 * A load failure is deliberately NOT caught here. There is exactly one place
 * that decides what an unusable engine means to the user, and adding a second
 * one would let a broken engine masquerade as a working one.
 */

import type { AIEngine, EngineType } from './types';
// The one exception to lazy loading: the OpenCode server module holds a
// process-wide client singleton that shutdown must release. It is imported
// directly (not via the adapter barrel) so it does not drag in the engine class.
import { disposeOpenCodeClient } from './adapters/opencode/server';
import { debug } from '$shared/utils/logger';

// ============================================================================
// Adapter loading
// ============================================================================

/**
 * The only reference to an adapter module anywhere in this registry. Being a
 * total `Record<EngineType, …>`, adding an engine will not type-check until its
 * loader is registered here — the exhaustiveness the old `switch` needed a
 * runtime `default` branch to approximate.
 */
const ENGINE_LOADERS: Record<EngineType, () => Promise<AIEngine>> = {
	'claude-code': async () => new (await import('./adapters/claude')).ClaudeCodeEngine(),
	opencode: async () => new (await import('./adapters/opencode')).OpenCodeEngine(),
	copilot: async () => new (await import('./adapters/copilot')).CopilotEngine(),
	codex: async () => new (await import('./adapters/codex')).CodexEngine(),
	qwen: async () => new (await import('./adapters/qwen')).QwenEngine(),
	pi: async () => new (await import('./adapters/pi')).PiEngine(),
	cline: async () => new (await import('./adapters/cline')).ClineEngine(),
	cursor: async () => new (await import('./adapters/cursor')).CursorEngine(),
};

/**
 * A cache entry. `pending` is what callers await — sharing it means concurrent
 * callers get one instance rather than racing to build two. `instance` is the
 * settled value, for callers that must read an engine without creating one.
 */
interface EngineSlot {
	pending: Promise<AIEngine>;
	instance: AIEngine | null;
}

/**
 * Get (or start) the cached creation of an engine in the given cache.
 *
 * A failed creation is evicted rather than cached: the usual cause is an engine
 * the user has not installed yet, and they must be able to install it in
 * Settings → Stack and retry without restarting the server.
 */
function slotFor(type: EngineType, cache: Map<EngineType, EngineSlot>): EngineSlot {
	const cached = cache.get(type);
	if (cached) return cached;

	const load = ENGINE_LOADERS[type];
	// Engine types reach us from stored settings, so an unknown one is possible
	// even though the type system rules it out at every call site.
	if (!load) throw new Error(`Unknown engine type: ${type}`);

	const slot: EngineSlot = {
		instance: null,
		pending: load().then(
			engine => { slot.instance = engine; return engine; },
			error => { cache.delete(type); throw error; }
		),
	};
	cache.set(type, slot);
	return slot;
}

// ============================================================================
// Global Singletons — for non-streaming operations (models, settings, etc.)
// ============================================================================

const engines = new Map<EngineType, EngineSlot>();

/**
 * Get (or create) a global singleton engine instance by type.
 * Use for non-streaming operations only (e.g. models:list).
 */
export async function getEngine(type: EngineType): Promise<AIEngine> {
	const cached = engines.get(type);
	if (cached) return cached.pending;

	const slot = slotFor(type, engines);
	debug.log('engine', `Global engine instance created: ${type}`);
	return slot.pending;
}

/**
 * Initialize a global engine (call this before streaming if you want eager init).
 */
export async function initializeEngine(type: EngineType): Promise<AIEngine> {
	const engine = await getEngine(type);
	if (!engine.isInitialized) {
		await engine.initialize();
	}
	return engine;
}

/**
 * Dispose a specific global engine and release its resources.
 */
export async function disposeEngine(type: EngineType): Promise<void> {
	const slot = engines.get(type);
	if (slot) {
		engines.delete(type);
		if (slot.instance) await slot.instance.dispose();
		debug.log('engine', `Global engine disposed: ${type}`);
	}
}

// ============================================================================
// Retirement — replacing an engine without killing what it is doing
// ============================================================================

/**
 * Engines removed from a cache but still mid-stream, awaiting a quiet moment.
 *
 * Disposing an engine tears down its SDK process and aborts whatever query it is
 * running. That is right at shutdown and wrong everywhere else: switching a
 * Copilot account or editing a connector used to call `dispose()` immediately,
 * which killed any chat that happened to be streaming at that moment — silently,
 * from the user's point of view, since nothing in the UI connects "I changed a
 * setting" to "that answer stopped halfway".
 *
 * Retiring instead evicts the instance from the cache so the next stream builds a
 * fresh one, and disposes the old one once it goes idle. New work gets the new
 * config; work already in flight finishes under the config it started with.
 */
const retired = new Set<AIEngine>();
/** How often retired instances are re-checked for idleness. */
const RETIRE_POLL_MS = 2000;
let retireTimer: ReturnType<typeof setInterval> | null = null;

function disposeWhenIdle(engine: AIEngine, label: string): void {
	if (!engine.isActive) {
		void engine.dispose().catch(error => debug.error('engine', `Error disposing ${label}:`, error));
		debug.log('engine', `Engine disposed: ${label}`);
		return;
	}

	retired.add(engine);
	debug.log('engine', `Engine retired while busy, will dispose when idle: ${label}`);
	if (retireTimer) return;

	retireTimer = setInterval(() => {
		for (const candidate of [...retired]) {
			if (candidate.isActive) continue;
			retired.delete(candidate);
			void candidate.dispose().catch(error => debug.error('engine', 'Error disposing retired engine:', error));
			debug.log('engine', `Retired engine disposed after going idle: ${candidate.name}`);
		}
		if (retired.size === 0 && retireTimer) {
			clearInterval(retireTimer);
			retireTimer = null;
		}
	}, RETIRE_POLL_MS);
	retireTimer.unref?.();
}

/**
 * Evict every instance of an engine type — global and per-project — so the next
 * stream rebuilds it, without interrupting any stream currently using one.
 *
 * This is what account switches, credential edits and config changes call.
 */
export function retireEnginesByType(type: EngineType): void {
	const slot = engines.get(type);
	if (slot) {
		engines.delete(type);
		if (slot.instance) disposeWhenIdle(slot.instance, `global ${type}`);
	}

	for (const [projectId, projectMap] of projectEngines) {
		const projectSlot = projectMap.get(type);
		if (!projectSlot) continue;
		projectMap.delete(type);
		if (projectSlot.instance) disposeWhenIdle(projectSlot.instance, `${type} for project ${projectId.slice(0, 8)}`);
		if (projectMap.size === 0) projectEngines.delete(projectId);
	}
}

/** Evict every engine of every type, letting in-flight streams finish. */
export function retireAllEngines(): void {
	for (const type of new Set<EngineType>([...engines.keys(), ...[...projectEngines.values()].flatMap(m => [...m.keys()])])) {
		retireEnginesByType(type);
	}
}

/**
 * Dispose all global engines (used on server shutdown).
 */
export async function disposeAllEngines(): Promise<void> {
	for (const [type, slot] of engines) {
		try {
			if (slot.instance) await slot.instance.dispose();
			debug.log('engine', `Global engine disposed: ${type}`);
		} catch (error) {
			debug.error('engine', `Error disposing global engine ${type}:`, error);
		}
	}
	engines.clear();

	// Also dispose all project engines
	await disposeAllProjectEngines();
}

// ============================================================================
// Per-Project Instances — for streaming (fully isolated per project)
// ============================================================================

/** projectId → (engineType → EngineSlot) */
const projectEngines = new Map<string, Map<EngineType, EngineSlot>>();

/**
 * Get (or create) an engine instance scoped to a specific project.
 *
 * Scoped per project, so one project's streams never reach another's. Within a
 * project the instance is SHARED by every chat session — see the note at the
 * top of this file for what that means for adapters.
 */
export async function getProjectEngine(projectId: string, type: EngineType): Promise<AIEngine> {
	let engines = projectEngines.get(projectId);
	if (!engines) {
		engines = new Map();
		projectEngines.set(projectId, engines);
	}

	const cached = engines.get(type);
	if (cached) return cached.pending;

	const slot = slotFor(type, engines);
	debug.log('engine', `Project engine created: ${type} for project ${projectId.slice(0, 8)}`);
	return slot.pending;
}

/**
 * The engine already created for a project, or undefined.
 *
 * For callers acting on a stream that is already running — cancelling it,
 * routing an answer back into it. Those must never create an engine: a fresh
 * instance has nothing to cancel and no pending question, so building one would
 * only hide the fact that the real engine went missing.
 */
export function findProjectEngine(projectId: string, type: EngineType): AIEngine | undefined {
	return projectEngines.get(projectId)?.get(type)?.instance ?? undefined;
}

/**
 * Initialize a project-scoped engine.
 */
export async function initializeProjectEngine(projectId: string, type: EngineType): Promise<AIEngine> {
	const engine = await getProjectEngine(projectId, type);
	if (!engine.isInitialized) {
		await engine.initialize();
	}
	return engine;
}

/**
 * Dispose a specific project engine.
 */
export async function disposeProjectEngine(projectId: string, type: EngineType): Promise<void> {
	const engines = projectEngines.get(projectId);
	if (engines) {
		const slot = engines.get(type);
		if (slot) {
			engines.delete(type);
			if (slot.instance) await slot.instance.dispose();
			debug.log('engine', `Project engine disposed: ${type} for project ${projectId.slice(0, 8)}`);
		}
		if (engines.size === 0) {
			projectEngines.delete(projectId);
		}
	}
}

/**
 * Dispose all engines for a specific project.
 */
export async function disposeProjectEngines(projectId: string): Promise<void> {
	const engines = projectEngines.get(projectId);
	if (engines) {
		for (const [type, slot] of engines) {
			try {
				if (slot.instance) await slot.instance.dispose();
				debug.log('engine', `Project engine disposed: ${type} for project ${projectId.slice(0, 8)}`);
			} catch (error) {
				debug.error('engine', `Error disposing project engine ${type}:`, error);
			}
		}
		projectEngines.delete(projectId);
	}
}

/**
 * Dispose all instances of a given engine type across all projects, plus the
 * global singleton. Call when an account/credential change requires every
 * client to re-initialise (e.g. Copilot account switch).
 *
 * Retires rather than tears down — see `retireEnginesByType`. Kept async so the
 * many `await`ing call sites read unchanged.
 */
export async function disposeAllProjectEnginesByType(type: EngineType): Promise<void> {
	retireEnginesByType(type);
}

/**
 * Dispose all project engines (used on server shutdown).
 */
async function disposeAllProjectEngines(): Promise<void> {
	for (const [projectId, engines] of projectEngines) {
		for (const [type, slot] of engines) {
			try {
				if (slot.instance) await slot.instance.dispose();
			} catch (error) {
				debug.error('engine', `Error disposing project engine ${type} for ${projectId.slice(0, 8)}:`, error);
			}
		}
	}
	projectEngines.clear();

	// Dispose the OpenCode client/server (module-level singleton)
	await disposeOpenCodeClient();
}

// Re-export types
export type { AIEngine, EngineType, EngineQueryOptions } from './types';
