/**
 * Generation target resolution.
 *
 * One-shot `generateStructured` callers (git commit/branch generator, artifact
 * authoring) take engine + provider + model as three loose strings chosen
 * client-side. Whenever those are persisted as separate fields they can drift:
 * a UI that updates `engine`/`modelId` but forgets `provider` leaves a provider
 * belonging to a completely different engine.
 *
 * That drift is invisible on engines that ignore `providerSlug` (Claude, Codex,
 * Qwen, Copilot, Cursor — they key off `modelId` alone) and fatal on the ones
 * that don't: OpenCode passes it as `model.providerID` (→ "OpenCode returned
 * empty response"), Pi and Cline look their account up by provider (→ "no
 * account for provider X").
 *
 * The engine's own catalog is the only source of truth for which provider and
 * account a model belongs to, so resolve against it and treat the caller's
 * `providerSlug` as a hint. Keeping this in one place means a new engine is
 * covered without touching any call site.
 */

import { getModelsByEngine, registerModels } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import type { EngineModel } from '$shared/types/unified';
import type { AIEngine } from './types';

/** Engine-verified coordinates for a one-shot generation call. */
export interface GenerationTarget {
	providerSlug: string;
	modelId: string;
	/** Account owning the model; omitted for engines with a single implicit account. */
	accountId?: number;
}

/**
 * Resolve `providerSlug` (and the owning account) for `modelId` from the
 * engine's catalog. `providerHint` is the caller-supplied slug — used only when
 * the catalog can't answer.
 *
 * Throws when the model belongs to no provider this engine offers, which is a
 * far more actionable error than the engine-specific failure it would become.
 */
export async function resolveGenerationTarget(
	engine: AIEngine,
	modelId: string,
	providerHint?: string
): Promise<GenerationTarget> {
	const engineType = engine.name;
	const byId = (models: EngineModel[]) => models.find(m => m.engine.model.id === modelId);

	// The registry is filled by `models:list`; only pay for a catalog fetch when
	// this process hasn't seen the engine (or the model) yet.
	let catalog = getModelsByEngine(engineType);
	let match = byId(catalog);

	if (!match) {
		try {
			catalog = await engine.getAvailableModels();
			registerModels(engineType, catalog);
			match = byId(catalog);
		} catch (error) {
			debug.warn('engine', `Catalog fetch failed for ${engineType}; using caller provider "${providerHint ?? ''}" for ${modelId}:`, error);
			return { providerSlug: providerHint ?? '', modelId };
		}
	}

	if (match) {
		if (providerHint && providerHint !== match.engine.provider) {
			debug.warn('engine', `Ignoring stale provider "${providerHint}" for ${engineType}/${modelId} — catalog says "${match.engine.provider}"`);
		}
		const accountId = match.engine.account.id;
		return {
			providerSlug: match.engine.provider,
			modelId: match.engine.model.id,
			...(accountId ? { accountId } : {})
		};
	}

	// Unknown model: only trust the hint if this engine actually serves that
	// provider, otherwise it is drift and would fail deep inside the adapter.
	if (providerHint && catalog.some(m => m.engine.provider === providerHint)) {
		debug.warn('engine', `Model "${modelId}" missing from ${engineType} catalog; falling back to caller provider "${providerHint}"`);
		return { providerSlug: providerHint, modelId };
	}

	throw new Error(`Model "${modelId}" is not available for engine "${engineType}". Pick it again in Settings → Models.`);
}
