/**
 * Models Store with Svelte 5 Runes
 *
 * Manages available AI models per engine. All engines fetch their catalog
 * from the backend via the `models:list` WS endpoint — there is no static
 * frontend fallback. Each engine adapter owns its catalog logic in
 * `backend/engine/adapters/<engine>/models.ts`.
 */

import { registerModels } from '$shared/constants/engines';
import type { EngineModel, EngineType } from '$shared/types/unified';
import ws from '$frontend/utils/ws';

import { debug } from '$shared/utils/logger';

let models = $state<EngineModel[]>([]);
let loading = $state(false);
let fetchedEngines = $state<Set<EngineType>>(new Set());
let errors = $state<Map<EngineType, string>>(new Map());

export const modelStore = {
	get models() { return models; },
	get loading() { return loading; },

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

	/** Get a model by its ID */
	getById(modelId: string): EngineModel | undefined {
		return models.find(m => m.engine.model.id === modelId);
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
		loading = true;
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
			loading = false;
		}
	},

	/** Clear the model cache so the next fetchModels() call re-hits the backend. */
	reset(): void {
		models = [];
		fetchedEngines = new Set();
		errors = new Map();
	}
};
