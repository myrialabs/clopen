/**
 * Models Store with Svelte 5 Runes
 *
 * Manages available AI models per engine. All engines fetch their catalog
 * from the backend via the `models:list` WS endpoint — there is no static
 * frontend fallback. Each engine adapter owns its catalog logic in
 * `backend/engine/adapters/<engine>/models.ts`.
 */

import { untrack } from 'svelte';
import { registerModels } from '$shared/constants/engines';
import type { EngineModel, EngineType } from '$shared/types/unified';
import ws from '$frontend/utils/ws';

import { debug } from '$shared/utils/logger';

let models = $state<EngineModel[]>([]);
// Per-engine in-flight fetch count. A single global flag let one engine's
// fetch (e.g. a background refresh after an account switch) flip another
// engine's picker into "Loading..." — and its finally{} cleared the flag while
// a second engine was still mid-fetch. A count (not a boolean) keeps
// overlapping fetches of the SAME engine honest too.
let loadingEngines = $state<Map<EngineType, number>>(new Map());
let fetchedEngines = $state<Set<EngineType>>(new Set());
let errors = $state<Map<EngineType, string>>(new Map());

export const modelStore = {
	get models() { return models; },
	/** True while ANY engine's catalog is being fetched. Prefer isLoading(engine). */
	get loading() { return loadingEngines.size > 0; },

	/** True while this engine's catalog is being fetched. */
	isLoading(engine: EngineType): boolean {
		return loadingEngines.has(engine);
	},

	/** Whether this engine's catalog has been fetched successfully at least once. */
	isFetched(engine: EngineType): boolean {
		return fetchedEngines.has(engine);
	},

	/** Get the most recent fetch error for an engine, if any */
	getError(engine: EngineType): string | undefined {
		return errors.get(engine);
	},

	/** Get chat-compatible models filtered by engine (must support text I/O and tools) */
	getByEngine(engine: EngineType): EngineModel[] {
		return models.filter(m =>
			m.engine.type === engine &&
			m.modalities.input.text &&
			m.modalities.output.text &&
			m.capabilities.tools
		);
	},

	/**
	 * Get a model by its ID across ALL engines.
	 * Model ids collide between engines (e.g. the same OpenAI id served by
	 * Codex, OpenCode and Pi) — when the engine is known, use getForEngine().
	 */
	getById(modelId: string): EngineModel | undefined {
		return models.find(m => m.engine.model.id === modelId);
	},

	/** Get a model by engine + ID (exact match on both). */
	getForEngine(engine: EngineType, modelId: string): EngineModel | undefined {
		return models.find(m => m.engine.type === engine && m.engine.model.id === modelId);
	},

	/**
	 * Fetch models for a specific engine from the backend.
	 * Uses cache by default — call refreshModels() to bypass.
	 */
	async fetchModels(engine: EngineType): Promise<EngineModel[]> {
		// Skip if already fetched for this engine (even if 0 models)
		if (fetchedEngines.has(engine)) {
			return models.filter(m => m.engine.type === engine);
		}

		return this._doFetch(engine);
	},

	/**
	 * Force re-fetch models for an engine, bypassing cache.
	 */
	async refreshModels(engine: EngineType): Promise<EngineModel[]> {
		return this._doFetch(engine);
	},

	/** Internal fetch logic shared by fetchModels and refreshModels */
	async _doFetch(engine: EngineType): Promise<EngineModel[]> {
		// untrack: callers kick fetches off from $effects; reading the map we are
		// about to write would make that effect depend on it and loop.
		untrack(() => {
			loadingEngines = new Map(loadingEngines).set(engine, (loadingEngines.get(engine) ?? 0) + 1);
		});
		try {
			const fetched = await ws.http('models:list', { engine });
			const engineModels = fetched as EngineModel[];

			// Update shared registry
			registerModels(engine, engineModels);

			// Update local reactive state: replace models for this engine
			const otherModels = models.filter(m => m.engine.type !== engine);
			models = [...otherModels, ...engineModels];
			fetchedEngines = new Set([...fetchedEngines, engine]);

			if (errors.has(engine)) {
				const next = new Map(errors);
				next.delete(engine);
				errors = next;
			}

			debug.log('settings', `Fetched ${engineModels.length} models for ${engine}`);
			return engineModels;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debug.error('settings', `Failed to fetch models for ${engine}:`, error);

			// Drop any stale models for this engine so the picker reflects the failure.
			// Intentionally do NOT add this engine to fetchedEngines so a remount
			// (e.g. after the user configures an account in Settings → Engines)
			// retries the fetch instead of serving the cached failure.
			const otherModels = models.filter(m => m.engine.type !== engine);
			models = otherModels;

			const next = new Map(errors);
			next.set(engine, message);
			errors = next;

			return [];
		} finally {
			const next = new Map(loadingEngines);
			const remaining = (next.get(engine) ?? 1) - 1;
			if (remaining > 0) next.set(engine, remaining);
			else next.delete(engine);
			loadingEngines = next;
		}
	},

	/** Clear the model cache so the next fetchModels() call re-hits the backend. */
	reset(): void {
		models = [];
		fetchedEngines = new Set();
		errors = new Map();
	}
};

/**
 * Keep the catalog in step with engine config, without anyone asking.
 *
 * Adding a provider or switching an account changes which models exist, and the
 * backend applies that on its own now — so the only thing left for the client to
 * do is stop showing the old answer. This used to ride on the "Restart Server"
 * button's success path, which meant the picker was only correct for users who
 * pressed it.
 *
 * Refetches only what has already been fetched: an engine nobody has opened yet
 * has no stale list to correct, and pulling its catalog here would spend a
 * round-trip per engine on every settings edit.
 */
ws.on('engine:config-changed', () => {
	const engines = [...fetchedEngines];
	if (engines.length === 0) return;
	debug.log('settings', `Engine config changed — refreshing models for ${engines.join(', ')}`);
	for (const engine of engines) {
		void modelStore.refreshModels(engine).catch(() => {
			// A refresh that fails leaves the previous list in place and records the
			// error through the normal path; nothing extra to do here.
		});
	}
});
