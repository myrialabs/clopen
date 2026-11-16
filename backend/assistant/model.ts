/**
 * Which model the Clopen assistant itself runs on.
 *
 * The assistant drives every other agent through tools, so it needs a model
 * that can call tools — and on a fresh install it must work before anyone has
 * connected an account. The default is therefore OpenCode's best free,
 * tool-capable model (installed automatically on first launch). Once the
 * owner picks a model in the assistant's own chat, that choice wins: the
 * latest assistant session's model is reused.
 */

import { getOwner } from '$backend/auth/auth-service';
import { callRouteAs } from '$backend/control/invoke';
import { latestSession, modelOf, pickModel, type ModelChoice } from '$backend/control/workspace';
import { isFreeModel, pickDefaultModel } from '$shared/constants/engines';
import type { EngineModel } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { ensureAssistantProject } from './project';
import { getModelChoice, rememberFreeModel } from './model-choices';

/** The free OpenCode model every job in Settings → Models uses when none is picked for it, ranked like every default. */
export async function freeAssistantModel(): Promise<ModelChoice | null> {
	const owner = getOwner();
	if (!owner) return null;
	try {
		const models = await callRouteAs<EngineModel[]>(owner, 'models:list', { engine: 'opencode' });
		const free = models.filter((model) => isFreeModel(model) && model.capabilities.tools);
		const pick = pickDefaultModel(free.length ? free : models);
		if (!pick) return null;
		const choice: ModelChoice = {
			engine: 'opencode',
			provider: pick.engine.provider,
			modelId: pick.engine.model.id,
			modelName: pick.engine.model.name
		};
		rememberFreeModel(choice);
		return choice;
	} catch (error) {
		debug.warn('assistant', 'OpenCode models are not available for the assistant yet:', error);
		return null;
	}
}

/** The model a NEW assistant session starts with: the owner's choice, then the latest one used, then the free default. */
export async function pickAssistantModel(): Promise<ModelChoice | null> {
	const saved = getModelChoice('assistant');
	if (saved) return saved;
	const project = ensureAssistantProject();
	const chosen = modelOf(latestSession(project.id));
	if (chosen) return chosen;
	const free = await freeAssistantModel();
	if (free) return free;
	const owner = getOwner();
	return owner ? pickModel(owner.id, project.id) : null;
}

// ── Model per purpose (Settings → Models) ───────────────────────────────────
// Kept in `model-choices.ts`, which imports almost nothing, so a module far from
// the assistant (memory) can read a choice without pulling this one in.

export { getModelChoice, getModelChoices, knownFreeModel, saveModelChoice, type ModelPurpose } from './model-choices';
