/**
 * Resolves which engine/model an AI-assist feature runs on: the feature's own
 * override (Settings → Models → Git / Artifacts) when enabled, otherwise the
 * assistant model.
 *
 * One helper for every caller so a new feature can't reinvent — and get wrong —
 * the three fields that must travel together. `providerSlug` is a hint only:
 * the backend re-derives it from the engine catalog (see
 * `backend/engine/resolve-model.ts`), so a stored provider that fell out of
 * sync with `modelId` can't break generation.
 */

import { settings } from '$frontend/stores/features/settings.svelte';
import type { EngineModel, EngineType } from '$shared/types/unified';

/** The model-override shape shared by `commitGenerator` and `artifactGenerator`. */
export interface ModelOverride {
	useCustomModel: boolean;
	engine: EngineType;
	provider: string;
	modelId: string;
}

export interface ResolvedGenerationModel {
	engine: EngineType;
	providerSlug: string;
	modelId: string;
}

/**
 * The persisted model fields of an override, derived from one catalog entry.
 * Spread this when saving so `provider`, `modelId`, and `modelName` can never
 * be written apart — a provider left behind by a model change is exactly the
 * drift that used to break OpenCode/Pi/Cline generation.
 */
export function modelFieldsOf(model: EngineModel | undefined, fallbackId = ''): {
	provider: string;
	modelId: string;
	modelName: string;
} {
	return {
		provider: model?.engine.provider ?? '',
		modelId: model?.engine.model.id ?? fallbackId,
		modelName: model?.engine.model.name ?? fallbackId
	};
}

/** Resolve an override (or the assistant model when it's off/absent). */
export function resolveGenerationModel(override?: ModelOverride | null): ResolvedGenerationModel {
	if (override?.useCustomModel) {
		return {
			engine: override.engine,
			providerSlug: override.provider,
			modelId: override.modelId
		};
	}
	return {
		engine: settings.selectedEngine,
		providerSlug: settings.selectedProvider,
		modelId: settings.selectedModelId
	};
}
