/**
 * Models Store with Svelte 5 Runes
 *
 * Manages available AI models per engine.
 * All engines (Claude Code and Open Code) fetch models dynamically
 * from the backend via `models:list` endpoint.
 */

import { CLAUDE_CODE_MODELS, registerModels } from '$shared/constants/engines';
import type { EngineModel, EngineType } from '$shared/types/engine';
import ws from '$frontend/lib/utils/ws';

import { debug } from '$shared/utils/logger';

// Reactive state — start with static fallback until first fetch completes
let models = $state<EngineModel[]>([...CLAUDE_CODE_MODELS]);
let loading = $state(false);
let fetchedEngines = $state<Set<EngineType>>(new Set());

export const modelStore = {
	get models() { return models; },
	get loading() { return loading; },

	/** Get models filtered by engine */
	getByEngine(engine: EngineType): EngineModel[] {
		return models.filter(m => m.engine === engine);
	},

	/** Get a model by its compound ID */
	getById(modelId: string): EngineModel | undefined {
		return models.find(m => m.id === modelId);
	},

	/**
	 * Fetch models for a specific engine from the backend.
	 * Uses cache by default — call refreshModels() to bypass.
	 */
	async fetchModels(engine: EngineType): Promise<EngineModel[]> {
		// Skip if already fetched for this engine
		if (fetchedEngines.has(engine)) {
			const existing = models.filter(m => m.engine === engine);
			if (existing.length > 0) return existing;
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
			const otherModels = models.filter(m => m.engine !== engine);
			models = [...otherModels, ...engineModels];
			fetchedEngines = new Set([...fetchedEngines, engine]);

			debug.log('settings', `Fetched ${engineModels.length} models for ${engine}`);
			return engineModels;
		} catch (error) {
			debug.error('settings', `Failed to fetch models for ${engine}:`, error);
			// For claude-code, return static fallback on fetch failure
			if (engine === 'claude-code') {
				return CLAUDE_CODE_MODELS;
			}
			return [];
		} finally {
			loading = false;
		}
	},

	/** Reset to only static models */
	reset(): void {
		models = [...CLAUDE_CODE_MODELS];
		fetchedEngines = new Set();
	}
};
