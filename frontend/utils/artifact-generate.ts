/**
 * Client helper for AI-authoring an artifact from a purpose sentence. Resolves
 * which model to use (the "Artifacts" override in Settings → Models, else the
 * assistant model) and calls the `artifacts:generate` endpoint.
 */

import ws from '$frontend/utils/ws';
import { settings } from '$frontend/stores/features/settings.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';

export type GeneratableArtifactType = 'skill' | 'command' | 'subagent' | 'instruction';

/** Generate a draft artifact; returns a loose bag of fields for the editor to prefill. */
export async function generateArtifactDraft(
	artifactType: GeneratableArtifactType,
	purpose: string
): Promise<Record<string, unknown>> {
	const gen = settings.artifactGenerator;
	const useCustom = !!gen?.useCustomModel;
	const engine = useCustom ? gen!.engine : settings.selectedEngine;
	const providerSlug = useCustom ? gen!.provider : settings.selectedProvider;
	const modelId = useCustom ? gen!.modelId : settings.selectedModelId;

	if (!modelId) throw new Error('No model configured. Pick one in Settings → Models.');

	const result = await ws.http('artifacts:generate', {
		artifactType,
		purpose,
		engine,
		providerSlug,
		modelId,
		projectId: projectState.currentProject?.id
	});
	return result.fields;
}
