/**
 * Client helper for AI-authoring an artifact from a purpose sentence. Resolves
 * which model to use (the "Artifacts" override in Settings → Models, else the
 * assistant model) and calls the `artifacts:generate` endpoint.
 */

import ws from '$frontend/utils/ws';
import { settings } from '$frontend/stores/features/settings.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { resolveGenerationModel, GENERATION_TIMEOUT_MS } from '$frontend/utils/model-override';

export type GeneratableArtifactType = 'skill' | 'command' | 'subagent' | 'instruction';

/** Generate a draft artifact; returns a loose bag of fields for the editor to prefill. */
export async function generateArtifactDraft(
	artifactType: GeneratableArtifactType,
	purpose: string
): Promise<Record<string, unknown>> {
	const { engine, providerSlug, modelId } = resolveGenerationModel(settings.artifactGenerator);

	// The backend repeats this check against the engine's live catalog (see
	// `resolve-model.ts`); this one just avoids a round-trip for the common case.
	if (!modelId) {
		throw new Error(
			settings.artifactGenerator?.useCustomModel
				? 'No model is selected for generating artifacts. Choose one in Settings → Models → Artifacts.'
				: 'No assistant model is selected. Choose one in Settings → Models.'
		);
	}

	const result = await ws.http('artifacts:generate', {
		artifactType,
		purpose,
		engine,
		providerSlug,
		modelId,
		projectId: projectState.currentProject?.id
	}, GENERATION_TIMEOUT_MS);
	return result.fields;
}
