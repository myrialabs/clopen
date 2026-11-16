/**
 * The memory writer when none is picked for it: the free model every job in
 * Settings → Models defaults to — never another job's choice. Its own file,
 * importing only the model choices, so the readiness check and the extractor
 * can both use it without loading each other (or the assistant).
 */

import type { EngineType } from '$shared/types/unified';
import { knownFreeModel } from '$backend/assistant/model-choices';
import type { MemoryModelConfig } from './config';

export function sharedMemoryModel(): MemoryModelConfig | null {
	const choice = knownFreeModel();
	return choice ? { engine: choice.engine as EngineType, modelId: choice.modelId, ...(choice.provider ? { providerSlug: choice.provider } : {}) } : null;
}
