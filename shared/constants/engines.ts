import type { EngineType, EngineModel, EngineInfo } from '$shared/types/unified';
import { TOOL_ICONS } from '$shared/constants/tool-icons';

// Re-export engine types for convenience
export type { EngineModel, EngineType, EngineInfo };

// ============================================================================
// Engine Definitions
// ============================================================================

export const ENGINES: EngineInfo[] = [
	{
		type: 'opencode',
		name: 'Open Code',
		description: 'Multi-provider AI models',
		icon: TOOL_ICONS['opencode']
	},
	{
		type: 'claude-code',
		name: 'Claude Code',
		description: 'Anthropic Claude models',
		icon: TOOL_ICONS['claude-code']
	},
	{
		type: 'copilot',
		name: 'Copilot',
		description: 'GitHub Copilot models',
		icon: TOOL_ICONS['copilot']
	},
	{
		type: 'codex',
		name: 'Codex',
		description: 'OpenAI Codex models',
		icon: TOOL_ICONS['codex']
	},
	{
		type: 'qwen',
		name: 'Qwen Code',
		description: 'Alibaba Qwen models',
		icon: TOOL_ICONS['qwen']
	},
	{
		type: 'pi',
		name: 'Pi',
		description: 'Multi-provider AI models',
		icon: TOOL_ICONS['pi']
	},
	{
		type: 'cline',
		name: 'Cline',
		description: 'Multi-provider AI models',
		icon: TOOL_ICONS['cline']
	},
	{
		type: 'cursor',
		name: 'Cursor',
		description: 'Cursor Composer models',
		icon: TOOL_ICONS['cursor']
	}
];

export const getEngineInfo = (engineType: EngineType): EngineInfo | undefined => {
	return ENGINES.find(e => e.type === engineType);
};

// ============================================================================
// Engine-specific catalogs & presets
//
// Per-engine data (model lists, provider presets, etc.) lives with the adapter
// in `backend/engine/adapters/<engine>/`. The frontend never imports those
// modules directly — it loads what it needs at runtime via WS endpoints
// (`models:list`, `engine:qwen-presets-list`, …).
// ============================================================================

// ============================================================================
// Model Registry (mutable — engines register their catalog at runtime via
// the `models:list` WS endpoint, which calls each adapter's getAvailableModels()
// and replaces the engine's slice of the registry).
// ============================================================================

const modelRegistry: EngineModel[] = [];

/** Register models for a specific engine (replaces any existing models for that engine) */
export const registerModels = (engine: EngineType, models: EngineModel[]): void => {
	// Remove existing models for this engine
	const filtered = modelRegistry.filter(m => m.engine.type !== engine);
	modelRegistry.length = 0;
	modelRegistry.push(...filtered, ...models);
};

/** Get all registered models (snapshot) */
export const getAllModels = (): EngineModel[] => [...modelRegistry];


// ============================================================================
// Defaults
//
// Hardcoded so the shared module has no dependency on the per-adapter model
// catalogs. The chosen default (`claude-sonnet-5`) is the current recommended
// Sonnet model; claude-sonnet-4-6 moved to legacy.
// ============================================================================

export const DEFAULT_ENGINE: EngineType = 'opencode';
// OpenCode's catalog is dynamic (free, no-account providers), so there is no
// fixed default model id — the first available OpenCode model is selected at
// runtime once its SDK is installed (see AssistantSettings + the model picker).
export const DEFAULT_MODEL_ID = '';
export const DEFAULT_MODEL_NAME = '';

// ============================================================================
// Lookup Helpers
// ============================================================================

export const getModelById = (modelId: string): EngineModel | undefined => {
	return modelRegistry.find(model => model.engine.model.id === modelId);
};

export const getModelsByEngine = (engine: EngineType): EngineModel[] => {
	return modelRegistry.filter(model => model.engine.type === engine);
};

/** Get human-readable tags for a model (capabilities + input modalities) */
export function getModelTags(model: EngineModel): string[] {
	const tags: string[] = [];
	if (model.capabilities.reasoning) tags.push('Reasoning');
	if (model.modalities.input.image) tags.push('Image');
	if (model.modalities.input.pdf) tags.push('PDF');
	if (model.modalities.input.audio) tags.push('Audio');
	if (model.modalities.input.video) tags.push('Video');
	return tags;
}

/**
 * Pick the best default model from a list: the most capable one, measured by
 * how many capability/modality badges it exposes (see getModelTags). Ties keep
 * the earlier model, preserving the provider's original ordering. Returns
 * undefined for an empty list.
 */
export function pickDefaultModel(models: EngineModel[]): EngineModel | undefined {
	let best: EngineModel | undefined;
	let bestCount = -1;
	for (const model of models) {
		const count = getModelTags(model).length;
		if (count > bestCount) {
			best = model;
			bestCount = count;
		}
	}
	return best;
}
