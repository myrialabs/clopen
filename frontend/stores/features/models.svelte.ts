/**
 * Models Store with Svelte 5 Runes
 *
 * Manages available AI models per engine.
 * All engines (Claude Code and Open Code) fetch models dynamically
 * from the backend via `models:list` endpoint.
 */

import { CLAUDE_CODE_MODELS, registerModels } from '$shared/constants/engines';
import type { EngineModel, EngineType } from '$shared/types/unified';
import ws from '$frontend/utils/ws';

import { debug } from '$shared/utils/logger';

// Reactive state — start with static fallback until first fetch completes
let models = $state<EngineModel[]>([...CLAUDE_CODE_MODELS]);
let loading = $state(false);
let fetchedEngines = $state<Set<EngineType>>(new Set());

export const modelStore = {
	get models() { return models; },
	get loading() { return loading; },

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
