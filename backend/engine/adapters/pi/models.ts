/**
 * Pi dynamic model discovery.
 *
 * Pi resolves models from its built-in catalog (plus any custom providers in the
 * isolated `models.json`). We build a `ModelRuntime` seeded with every stored Pi
 * account's credential and ask it for the models that have valid auth
 * (`getAvailable()`), then translate each into an `EngineModel`.
 *
 * `engine.provider` carries the pi-ai provider id (e.g. 'anthropic', 'openai')
 * so the chat's send path can resolve the matching account by provider. Returns
 * `[]` on any failure (mirrors the OpenCode/Qwen dynamic-catalog contract — the
 * picker renders empty rather than a stale list).
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai';
import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import { DbCredentialStore, getPiAccounts } from './credential';
import { createPiRuntime } from './presets';

export async function fetchPiModels(): Promise<EngineModel[]> {
	try {
		const accounts = getPiAccounts();
		const store = new DbCredentialStore(accounts);
		const runtime = await createPiRuntime(store);
		const available = await runtime.getAvailable();
		const mapped = available.map(mapPiModel);
		debug.log('engine', `Pi getAvailableModels: ${mapped.length} models across ${accounts.length} account(s)`);
		return mapped;
	} catch (error) {
		debug.warn('engine', `Pi model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/**
 * Pi's reasoning knob is the agent `thinkingLevel`. The pi-ai catalog reports
 * the supported levels per model (`getSupportedThinkingLevels`), so the control
 * is fully model-driven. Skipped when a model only supports `off` (no reasoning).
 */
function buildPiReasoningControl(model: Model<Api>): ReasoningControl | undefined {
	const levels = getSupportedThinkingLevels(model);
	if (levels.length <= 1) return undefined;
	const fallback = model.reasoning ? clampThinkingLevel(model, 'medium') : 'off';
	return {
		levels: toReasoningOptions(levels),
		default: fallback,
	};
}

function mapPiModel(model: Model<Api>): EngineModel {
	const image = model.input.includes('image');
	const reasoningControl = buildPiReasoningControl(model);
	return {
		engine: {
			type: 'pi',
			provider: model.provider,
			model: { id: model.id, name: model.name || model.id },
			account: { id: 0, name: '' },
		},
		limit: { input: model.contextWindow ?? 0, output: model.maxTokens ?? 0 },
		modalities: {
			input: { text: true, image, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: !!model.reasoning, tools: true, structuredOutput: true, ...(reasoningControl && { reasoningControl }) },
		cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
	};
}
