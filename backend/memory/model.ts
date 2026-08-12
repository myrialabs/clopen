/**
 * Choosing the model that writes memories, without asking.
 *
 * This used to live in `MemoryModelSettings.svelte`, which defaulted to the
 * assistant model on mount. That works only for a user who OPENS
 * Settings → Model → Memory — and nothing prompts them to. Everyone else ran
 * with `model: null`, so every finished turn was queued, refused for want of a
 * model, and banked forever: memory looked switched on and recorded nothing.
 * A default that depends on a settings page being visited is not a default.
 *
 * So the choice is made here, from the same rule the Assistant page uses
 * (`pickDefaultModel` — the most capable model the engine offers, measured by
 * how many capability badges it carries), and it is made at two moments:
 *
 *   - at startup, best-effort, so a fresh install is configured before the user
 *     has done anything at all;
 *   - immediately before the first extraction, because at startup the catalog
 *     may not be loaded yet, while by the time a turn has finished the engine
 *     has certainly been asked for its models.
 *
 * It only ever fills a HOLE. An explicit choice is never overwritten, including
 * back to itself — this is a default, not a policy.
 */

import { DEFAULT_ENGINE, getModelsByEngine, pickDefaultModel, registerModels } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import { getEngine } from '$backend/engine';
import type { EngineType } from '$shared/types/unified';
import { getMemoryConfig, setMemoryConfig, type MemoryModelConfig } from './config';
import { notifyMemoryReadiness } from './notify';

/** Shared in-flight promise, so a startup call and a first extraction do not race. */
let inFlight: Promise<MemoryModelConfig | null> | null = null;

/**
 * Return the configured extraction model, choosing a default if none is set.
 *
 * Resolves to null when no catalog is reachable — an engine that has never been
 * authenticated has no models to pick from, and inventing an id would produce a
 * failure at extraction time rather than an honest "not configured yet".
 */
export function ensureMemoryModel(): Promise<MemoryModelConfig | null> {
	const existing = getMemoryConfig().model;
	if (existing?.modelId) return Promise.resolve(existing);
	if (inFlight) return inFlight;
	inFlight = resolve().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function resolve(): Promise<MemoryModelConfig | null> {
	// Re-read: a concurrent caller may have filled it while this one waited.
	const current = getMemoryConfig().model;
	if (current?.modelId) return current;

	const engineType: EngineType = DEFAULT_ENGINE;

	// The registry is populated by `models:list`, which the UI calls. Only pay for
	// a catalog fetch when this process has not seen the engine yet — at startup
	// it usually has not.
	let catalog = getModelsByEngine(engineType);
	if (catalog.length === 0) {
		try {
			catalog = await getEngine(engineType).getAvailableModels();
			registerModels(engineType, catalog);
		} catch (error) {
			debug.warn('memory', `Could not load the ${engineType} catalog to pick a memory model`, error);
			return null;
		}
	}

	const pick = pickDefaultModel(catalog);
	if (!pick) {
		debug.log('memory', `No ${engineType} model available yet — memory extraction stays unconfigured`);
		return null;
	}

	const model: MemoryModelConfig = {
		engine: engineType,
		modelId: pick.engine.model.id,
		...(pick.engine.provider && { providerSlug: pick.engine.provider }),
		...(pick.engine.account.id && { accountId: pick.engine.account.id })
	};

	setMemoryConfig({ model });
	notifyMemoryReadiness();
	debug.log('memory', `Memory extraction model defaulted to ${engineType}/${model.modelId}`);
	return model;
}
