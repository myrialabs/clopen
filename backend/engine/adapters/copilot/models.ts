/**
 * Copilot dynamic model discovery.
 *
 * Wraps `CopilotClient.listModels()` and translates `ModelInfo[]` into
 * `EngineModel[]`, always led by an `Auto` entry (see `AUTO_MODEL`).
 *
 * Failures are thrown, not returned as `[]`: an empty catalog renders as "No
 * models available for this engine", which hid the real cause — most often a
 * token GitHub no longer accepts — behind a message nobody could act on. The
 * thrown text reaches the model picker, which offers to open Copilot's
 * account settings.
 */

import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';

/**
 * Copilot's own router. `models.list` only returns models whose CAPI entry is
 * `model_picker_enabled`, and on Copilot Free none are — every model there is
 * reached through Auto, which the runtime still accepts as a session model
 * (runtime 1.0.90 routes it to an entitled model, e.g. `gpt-6-luna`). The 1.0.79
 * runtime injected this entry itself; 1.0.90 no longer does, so without it a
 * Free account has nothing to pick at all.
 */
const AUTO_MODEL: ModelInfo = {
	id: 'auto',
	name: 'Auto',
	capabilities: { supports: {}, limits: { max_context_window_tokens: 0 } },
} as ModelInfo;

export async function fetchCopilotModels(
	client: CopilotClient,
	cache: ModelInfo[] | null,
): Promise<{ models: EngineModel[]; cache: ModelInfo[] | null }> {
	let infos = cache;
	if (!infos) {
		try {
			infos = withAuto(await client.listModels());
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			// The models endpoint refuses fine-grained PATs that chat accepts, so
			// Auto is still a working choice — offer it instead of failing.
			if (raw.includes('Personal Access Tokens are not supported')) {
				debug.warn('engine', 'Copilot models.list rejects fine-grained PATs; offering Auto only');
				infos = [AUTO_MODEL];
			} else {
				throw new Error(summariseModelsError(raw));
			}
		}
	}
	return { models: infos.map(info => mapModelInfoToEngineModel(info)), cache: infos };
}

function withAuto(infos: ModelInfo[]): ModelInfo[] {
	return infos.some(info => info.id === AUTO_MODEL.id) ? infos : [AUTO_MODEL, ...infos];
}

/**
 * Turn a models.list failure into one actionable sentence for the picker.
 * Strips the JSON-RPC stack noise and maps known GitHub Copilot responses.
 */
function summariseModelsError(raw: string): string {
	const firstLine = raw.split('\n')[0]?.replace(/^Request models\.list failed with message:\s*/, '').trim() || raw;
	const fix = 'Update the token in Settings → Engines → Copilot.';

	if (raw.includes('Not authenticated')) {
		return `GitHub rejected the Copilot account's token — it is invalid, expired or revoked. ${fix}`;
	}
	if (raw.includes('Copilot Requests')) {
		return `The Copilot token is missing the "Copilot Requests" permission. ${fix}`;
	}
	if (raw.includes('401') || raw.toLowerCase().includes('unauthorized')) {
		return `GitHub refused the Copilot token. Check that it is valid and has Copilot access. ${fix}`;
	}
	return `Could not load Copilot models: ${firstLine}`;
}

/**
 * Copilot's reasoning knob is the SDK `SessionConfig.reasoningEffort`. The
 * models.list payload reports which levels each model accepts
 * (`supportedReasoningEfforts`) and its default (`defaultReasoningEffort`), so
 * the control is fully model-driven. Absent when the model doesn't support it.
 */
function buildCopilotReasoningControl(info: ModelInfo): ReasoningControl | undefined {
	if (!info.capabilities?.supports?.reasoningEffort) return undefined;
	const levels = info.supportedReasoningEfforts ?? [];
	if (levels.length === 0) return undefined;
	return {
		levels: toReasoningOptions(levels),
		default: info.defaultReasoningEffort ?? levels[0],
	};
}

function mapModelInfoToEngineModel(info: ModelInfo): EngineModel {
	const limits = info.capabilities?.limits;
	const supports = info.capabilities?.supports;
	const reasoningControl = buildCopilotReasoningControl(info);
	return {
		engine: {
			type: 'copilot',
			provider: 'github',
			model: { id: info.id, name: info.name },
			account: { id: 0, name: '' },
		},
		limit: {
			input: limits?.max_context_window_tokens ?? 0,
			output: 0,
		},
		modalities: {
			input: {
				text: true,
				image: !!supports?.vision,
				audio: false,
				video: false,
				pdf: false,
			},
			output: {
				text: true,
				image: false,
				audio: false,
				video: false,
				pdf: false,
			},
		},
		capabilities: {
			reasoning: !!supports?.reasoningEffort,
			tools: true,
			structuredOutput: false,
			...(reasoningControl && { reasoningControl }),
		},
		cost: {
			input: info.billing?.multiplier ?? 0,
			output: 0,
		},
	};
}
