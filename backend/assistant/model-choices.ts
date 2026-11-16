/**
 * The model picked for each of Clopen's own jobs (Settings → Models): Clopen,
 * Specialists, Background. Kept apart from `model.ts` on purpose — this file
 * imports only the settings table, so anything (memory included) can read a
 * choice without loading the assistant.
 */

import { settingsQueries } from '$backend/database/queries';
import { ws } from '$backend/utils/ws';
import type { ModelChoice } from '$backend/control/workspace';

export type ModelPurpose = 'assistant' | 'specialist' | 'background';

/**
 * One choice per purpose, in its own settings row — not inside the per-user
 * settings blob, which the web UI writes back whole and would silently undo a
 * change made from Telegram. This row is the single source of truth: the web
 * picker in Clopen's chat, `/model` in a chat app and Settings → Models all
 * write here, and every new Clopen chat, crew and background question reads it.
 */
const MODELS_KEY = 'assistant:models';

export function getModelChoices(): Partial<Record<ModelPurpose, ModelChoice>> {
	try {
		const raw = settingsQueries.get(MODELS_KEY)?.value;
		return raw ? (JSON.parse(raw) as Partial<Record<ModelPurpose, ModelChoice>>) : {};
	} catch {
		return {};
	}
}

export function getModelChoice(purpose: ModelPurpose): ModelChoice | null {
	const choice = getModelChoices()[purpose];
	return choice?.engine && choice.modelId ? choice : null;
}

/**
 * The free model a job uses when none is picked for it — every job in
 * Settings → Models defaults to it, none borrows another job's choice. Found
 * by `freeAssistantModel()` (it asks the engine), remembered here so code that
 * must not wait or load the assistant (memory's readiness) can read it.
 */
let freeModel: ModelChoice | null = null;

export function rememberFreeModel(model: ModelChoice | null): void {
	if (model) freeModel = model;
}

export function knownFreeModel(): ModelChoice | null {
	return freeModel;
}

/** Set (or clear, with null) the model for a purpose. */
export function saveModelChoice(purpose: ModelPurpose, model: ModelChoice | null): void {
	const next = { ...getModelChoices() };
	if (model) next[purpose] = { engine: model.engine, provider: model.provider, modelId: model.modelId, modelName: model.modelName };
	else delete next[purpose];
	settingsQueries.set(MODELS_KEY, JSON.stringify(next));
	try {
		ws.emit.global('assistant:changed', { scope: 'settings', id: null });
	} catch {
		// Announcing is best-effort.
	}
}
