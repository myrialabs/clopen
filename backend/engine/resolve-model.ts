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
 *
 * It is also the only place that can tell a MISCONFIGURED generation apart from
 * a failed one. An engine handed a blank or stale model id doesn't refuse — it
 * runs with no model and returns nothing, surfacing as "OpenCode returned empty
 * response" (or the equivalent on any other engine), which tells the user
 * neither what went wrong nor where to fix it. So the checks below fail loudly,
 * before the engine is called, naming the settings page that owns the choice.
 */

import { getModelsByEngine, registerModels, ENGINES } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import type { EngineModel } from '$shared/types/unified';
import type { AIEngine } from './types';

/** Human name for an engine, for error messages that point at Settings. */
function engineLabel(engineType: string): string {
	return ENGINES.find(e => e.type === engineType)?.name ?? engineType;
}

/** Engine-verified coordinates for a one-shot generation call. */
export interface GenerationTarget {
	providerSlug: string;
	modelId: string;
	/** Account owning the model; omitted for engines with a single implicit account. */
	accountId?: number;
}

/**
 * Where the user picks the model for this generation, named in error messages so
 * the fix is one click away instead of a guess.
 */
export const GENERATION_SETTINGS = {
	artifact: 'Settings → Models → Artifacts',
	commit: 'Settings → Models → Commit message',
	memory: 'Settings → Models → Memory',
	assistant: 'Settings → Models'
} as const;

export type GenerationSettingsPath = (typeof GENERATION_SETTINGS)[keyof typeof GENERATION_SETTINGS];

/**
 * Resolve `providerSlug` (and the owning account) for `modelId` from the
 * engine's catalog. `providerHint` is the caller-supplied slug — used only when
 * the catalog can't answer.
 *
 * Throws when the model is blank, when the engine offers no models at all, or
 * when the catalog says the model doesn't exist. Each of those would otherwise
 * become an opaque "returned empty response" deep inside an adapter.
 */
export async function resolveGenerationTarget(
	engine: AIEngine,
	modelId: string,
	providerHint?: string,
	settingsPath: string = GENERATION_SETTINGS.assistant
): Promise<GenerationTarget> {
	const engineType = engine.name;
	const label = engineLabel(engineType);
	const byId = (models: EngineModel[]) => models.find(m => m.engine.model.id === modelId);

	// No model at all. Engines that take `model` as optional silently fall back to
	// a default that may not exist, so this can never be passed through.
	if (!modelId.trim()) {
		throw new Error(`No model is selected for ${label}. Choose one in ${settingsPath}.`);
	}

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

	// The catalog came back empty: the engine isn't signed in, or has no provider
	// configured. Saying "pick a model again" would be useless — there is nothing
	// to pick until the engine itself is set up.
	if (catalog.length === 0) {
		throw new Error(
			`${label} has no models available — it may not be signed in or configured. ` +
			`Set it up in Settings → Engines → ${label}, then choose a model in ${settingsPath}.`
		);
	}

	// The catalog answered and this model isn't in it. Engines whose model list is
	// fetched live (OpenCode, Cline, Pi, Cursor) can drop a model between the day
	// it was saved and the day it is used, and passing the stale id through is
	// exactly what produced an empty response with no explanation.
	throw new Error(
		`Model "${modelId}" is no longer offered by ${label}. Choose a model again in ${settingsPath}.`
	);
}
