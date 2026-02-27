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
 *   Used by stream-manager for chat streaming.
 *   Each project gets its own engine instance so abort controllers,
 *   active queries, and session IDs are fully isolated.
 *   Cancelling Project A's stream never affects Project B.
 */

import type { AIEngine, EngineType } from './types';
import { ClaudeCodeEngine } from './adapters/claude';
import { OpenCodeEngine, disposeOpenCodeClient } from './adapters/opencode';
import { debug } from '$shared/utils/logger';

// ============================================================================
// Helpers
// ============================================================================

function createEngine(type: EngineType): AIEngine {
	switch (type) {
		case 'claude-code':
			return new ClaudeCodeEngine();
		case 'opencode':
			return new OpenCodeEngine();
		default:
			throw new Error(`Unknown engine type: ${type}`);
	}
}

// ============================================================================
// Global Singletons — for non-streaming operations (models, settings, etc.)
// ============================================================================

const engines = new Map<EngineType, AIEngine>();

/**
 * Get (or create) a global singleton engine instance by type.
 * Use for non-streaming operations only (e.g. models:list).
 */
export function getEngine(type: EngineType): AIEngine {
	let engine = engines.get(type);

	if (!engine) {
		engine = createEngine(type);
		engines.set(type, engine);
		debug.log('engine', `Global engine instance created: ${type}`);
	}

	return engine;
}

/**
 * Initialize a global engine (call this before streaming if you want eager init).
 */
export async function initializeEngine(type: EngineType): Promise<AIEngine> {
	const engine = getEngine(type);
	if (!engine.isInitialized) {
		await engine.initialize();
	}
	return engine;
}

/**
 * Dispose a specific global engine and release its resources.
 */
export async function disposeEngine(type: EngineType): Promise<void> {
	const engine = engines.get(type);
	if (engine) {
		await engine.dispose();
		engines.delete(type);
		debug.log('engine', `Global engine disposed: ${type}`);
	}
}

/**
 * Dispose all global engines (used on server shutdown).
 */
export async function disposeAllEngines(): Promise<void> {
	for (const [type, engine] of engines) {
		try {
			await engine.dispose();
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

/** projectId → (engineType → AIEngine) */
const projectEngines = new Map<string, Map<EngineType, AIEngine>>();

/**
 * Get (or create) an engine instance scoped to a specific project.
 * Each project gets its own engine with independent state (abort controllers,
 * active queries, session IDs), ensuring complete stream isolation.
 */
export function getProjectEngine(projectId: string, type: EngineType): AIEngine {
	if (!projectEngines.has(projectId)) {
		projectEngines.set(projectId, new Map());
	}

	const engines = projectEngines.get(projectId)!;
	let engine = engines.get(type);

	if (!engine) {
		engine = createEngine(type);
		engines.set(type, engine);
		debug.log('engine', `Project engine created: ${type} for project ${projectId.slice(0, 8)}`);
	}

	return engine;
}

/**
 * Initialize a project-scoped engine.
 */
export async function initializeProjectEngine(projectId: string, type: EngineType): Promise<AIEngine> {
	const engine = getProjectEngine(projectId, type);
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
		const engine = engines.get(type);
		if (engine) {
			await engine.dispose();
			engines.delete(type);
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
		for (const [type, engine] of engines) {
			try {
				await engine.dispose();
				debug.log('engine', `Project engine disposed: ${type} for project ${projectId.slice(0, 8)}`);
			} catch (error) {
				debug.error('engine', `Error disposing project engine ${type}:`, error);
			}
		}
		projectEngines.delete(projectId);
	}
}

/**
 * Dispose all project engines (used on server shutdown).
 */
async function disposeAllProjectEngines(): Promise<void> {
	for (const [projectId, engines] of projectEngines) {
		for (const [type, engine] of engines) {
			try {
				await engine.dispose();
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
