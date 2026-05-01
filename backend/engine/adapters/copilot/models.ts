/**
 * Copilot dynamic model discovery.
 *
 * Wraps `CopilotClient.listModels()` and translates `ModelInfo[]` into
 * `EngineModel[]`. Returns `[]` on any failure with a friendly error
 * message logged via `summariseModelsError` — common 4xx responses (PAT
 * missing the "Copilot Requests" scope, fine-grained PAT not accepted)
 * are mapped to actionable hints for the server log.
 */

import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import type { EngineModel } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';

export async function fetchCopilotModels(
	client: CopilotClient,
	cache: ModelInfo[] | null,
): Promise<{ models: EngineModel[]; cache: ModelInfo[] | null }> {
	try {
		const infos = cache ?? await client.listModels();
		return {
			models: infos.map(info => mapModelInfoToEngineModel(info)),
			cache: infos,
		};
	} catch (error) {
		debug.warn('engine', `Copilot models unavailable: ${summariseModelsError(error)}`);
		return { models: [], cache };
	}
}

/**
 * Build a one-line, human-readable summary of a models.list failure for the
 * server log. Strips the JSON-RPC stack frame noise and maps known GitHub
 * Copilot 4xx responses to actionable hints.
 */
function summariseModelsError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const firstLine = raw.split('\n')[0]?.trim() || raw;

	if (raw.includes('Personal Access Tokens are not supported')) {
		return 'the models.list endpoint does not accept fine-grained PATs (chat will still work if the PAT has Copilot Requests).';
	}
	if (raw.includes('Copilot Requests')) {
		return 'PAT is missing the "Copilot Requests" permission.';
	}
	if (raw.includes('401') || raw.toLowerCase().includes('unauthorized')) {
		return 'unauthorized — check that the GitHub PAT is valid and has Copilot access.';
	}
	return firstLine;
}

function mapModelInfoToEngineModel(info: ModelInfo): EngineModel {
	const limits = info.capabilities?.limits;
	const supports = info.capabilities?.supports;
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
		},
		cost: {
			input: info.billing?.multiplier ?? 0,
			output: 0,
		},
	};
}
