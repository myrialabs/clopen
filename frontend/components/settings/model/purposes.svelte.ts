/**
 * Every job a model does in Clopen — the one list Settings → Models is drawn
 * from: its name, what it is for in a line, and where the choice is kept.
 * Adding a job is one entry here, never a picker of its own somewhere; other
 * menus only say which model a job uses and link to its row here.
 *
 * Every job has a model of its own, and a job nothing was picked for uses
 * the free model — never another job's choice ("same as …" chains read as
 * "not set" and hid what actually ran). The server follows the same rule.
 */

import { assistantStore, type ModelRef } from '$frontend/stores/features/assistant.svelte';
import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
import type { EngineType } from '$shared/types/unified';

export type ModelPurposeId = 'assistant' | 'specialist' | 'chat' | 'background' | 'commits' | 'library' | 'memory';

export interface ModelPurposeInfo {
	id: ModelPurposeId;
	label: string;
	description: string;
}

export const MODEL_PURPOSES: ModelPurposeInfo[] = [
	{ id: 'assistant', label: 'Clopen', description: 'Talks with you, here and in Telegram. A fast model is enough.' },
	{ id: 'specialist', label: 'Specialists', description: 'The agents that do the work. A strong model pays off.' },
	{ id: 'chat', label: 'Project chats', description: 'New chats in your projects.' },
	{ id: 'background', label: 'Background', description: 'Quick decisions inside tasks: reviews, which way a step goes.' },
	{ id: 'commits', label: 'Commit messages', description: 'Commit messages and branch names.' },
	{ id: 'library', label: 'Library writer', description: 'Writes skills, prompts and agents for the Library.' },
	{ id: 'memory', label: 'Memory writer', description: 'Notes what is worth remembering after each chat.' }
];

export function purposeInfo(id: ModelPurposeId): ModelPurposeInfo {
	return MODEL_PURPOSES.find((entry) => entry.id === id)!;
}

/** The model picked for a job itself, or null when it uses the free model. */
export function pickedModel(id: ModelPurposeId): ModelRef | null {
	switch (id) {
		case 'assistant':
		case 'specialist':
		case 'background':
			return assistantStore.models[id] ?? null;
		case 'chat': {
			const picked = settings.selectedModelId ? { engine: settings.selectedEngine, provider: settings.selectedProvider, modelId: settings.selectedModelId, modelName: settings.selectedModelName || settings.selectedModelId } : null;
			// Project chats keep a concrete model; the free one picked there reads as "Free model".
			return picked && picked.modelId === assistantStore.freeModel?.modelId && picked.engine === assistantStore.freeModel?.engine ? null : picked;
		}
		case 'commits': {
			const own = settings.commitGenerator;
			return own?.useCustomModel && own.modelId ? { engine: own.engine, provider: own.provider, modelId: own.modelId, modelName: (own as { modelName?: string }).modelName || own.modelId } : null;
		}
		case 'library': {
			const own = settings.libraryGenerator;
			return own?.useCustomModel && own.modelId ? { engine: own.engine, provider: own.provider, modelId: own.modelId, modelName: own.modelName || own.modelId } : null;
		}
		case 'memory': {
			const own = memoryGraphStore.config?.model;
			return own?.modelId ? { engine: own.engine, provider: own.providerSlug ?? '', modelId: own.modelId, modelName: own.modelId } : null;
		}
	}
}

/** What a job runs on: its own model, or the free one. */
export function modelFor(id: ModelPurposeId): { model: ModelRef | null; free: boolean } {
	const own = pickedModel(id);
	return own ? { model: own, free: false } : { model: assistantStore.freeModel, free: true };
}

/** The line a job's model is shown as, here and in every menu that links to it. */
export function modelSummary(id: ModelPurposeId): string {
	const { model, free } = modelFor(id);
	if (!free) return model?.modelName ?? '';
	return model ? `Free model · ${model.modelName}` : 'Free model';
}

/** Pick the model for a job, or null for the free model. */
export async function savePurposeModel(id: ModelPurposeId, model: ModelRef | null): Promise<void> {
	switch (id) {
		case 'assistant':
		case 'specialist':
		case 'background':
			await assistantStore.saveModel(id, model);
			return;
		case 'chat': {
			// A project chat needs a concrete model to start with: "Free model" picks the free one.
			const chosen = model ?? assistantStore.freeModel;
			if (!chosen) return;
			updateSettings({ selectedEngine: chosen.engine as EngineType, selectedProvider: chosen.provider, selectedModelId: chosen.modelId, selectedModelName: chosen.modelName });
			return;
		}
		case 'commits':
			updateSettings({ commitGenerator: { ...settings.commitGenerator, useCustomModel: Boolean(model), ...(model ? { engine: model.engine as EngineType, provider: model.provider, modelId: model.modelId, modelName: model.modelName } : {}) } });
			return;
		case 'library': {
			const base = settings.libraryGenerator ?? { useCustomModel: false, engine: settings.selectedEngine, provider: '', modelId: '', modelName: '' };
			updateSettings({ libraryGenerator: { ...base, useCustomModel: Boolean(model), ...(model ? { engine: model.engine as EngineType, provider: model.provider, modelId: model.modelId, modelName: model.modelName } : {}) } });
			return;
		}
		case 'memory':
			await memoryGraphStore.saveConfig({ model: model ? { engine: model.engine as EngineType, modelId: model.modelId, ...(model.provider ? { providerSlug: model.provider } : {}) } : null });
			return;
	}
}
