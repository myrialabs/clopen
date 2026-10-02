/**
 * Qwen Code dynamic model discovery.
 *
 * Each preset (DashScope CN/INTL, OpenRouter, Fireworks) exposes the
 * OpenAI-compatible `/models` endpoint. We hit it with the active account's
 * API key and translate the response into `EngineModel[]` with conservative
 * default metadata — the SDK only needs the model id to dispatch a stream,
 * so anything beyond that is best-effort UI hinting. The one exception is the
 * reasoning-effort control, which is offered only when the endpoint itself
 * says the model accepts `reasoning_effort` (see `buildQwenReasoningControl`).
 *
 * Returns `[]` on any failure (network, auth, malformed body) so the caller
 * can surface an empty picker rather than a stale curated list — same shape
 * as OpenCode's `fetchOpenCodeModels` (see README §4.5).
 */

import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import type { QwenEnvResolution } from './environment';

const MODELS_FETCH_TIMEOUT_MS = 10_000;

interface OpenAiModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		context_length?: number;
		supported_parameters?: unknown;
		[key: string]: unknown;
	}>;
}

type OpenAiModelEntry = NonNullable<OpenAiModelsResponse['data']>[number];

/**
 * Tiers the bundled CLI sends to an OpenAI-compatible endpoint
 * (`OPENAI_COMPATIBLE_EFFORTS` in the SDK's CLI). The CLI clamps a tier the
 * endpoint rejects to the nearest accepted one, so offering the full set is safe.
 */
const QWEN_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * Qwen's knob is the SDK `effort` option, which the CLI turns into the
 * provider's own wire field. Whether a model honours it is only knowable from
 * the endpoint: OpenRouter lists `reasoning_effort` in `supported_parameters`.
 * DashScope and Fireworks publish no capability data on `/models`, so their
 * models get no selector and the provider default applies — sending an effort
 * to a model that can't reason would be dropped or rejected anyway.
 */
export function buildQwenReasoningControl(entry: OpenAiModelEntry): ReasoningControl | undefined {
	const params = entry.supported_parameters;
	if (!Array.isArray(params) || !params.includes('reasoning_effort')) return undefined;
	return { levels: toReasoningOptions(QWEN_EFFORT_LEVELS), default: 'medium' };
}

export async function fetchQwenModels(env: QwenEnvResolution): Promise<EngineModel[]> {
	const apiKey = env.env['OPENAI_API_KEY'];
	if (!apiKey) return [];

	const url = `${env.baseUrl.replace(/\/+$/, '')}/models`;
	try {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
			},
			signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			debug.warn('engine', `Qwen /models fetch failed: ${res.status} ${res.statusText}`);
			return [];
		}
		const json = (await res.json()) as OpenAiModelsResponse;
		const entries = Array.isArray(json.data) ? json.data : [];
		const mapped: EngineModel[] = [];
		for (const entry of entries) {
			if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
			mapped.push(mapQwenIdToEngineModel(entry.id, entry.name, entry.context_length, buildQwenReasoningControl(entry)));
		}
		return mapped;
	} catch (error) {
		debug.warn('engine', `Qwen /models fetch error: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function mapQwenIdToEngineModel(
	id: string,
	name?: string,
	contextLength?: number,
	reasoningControl?: ReasoningControl,
): EngineModel {
	const slashIdx = id.indexOf('/');
	const provider = slashIdx > 0 ? id.slice(0, slashIdx) : 'qwen';
	const displayName = name ?? (slashIdx > 0 ? id.slice(slashIdx + 1) : id);

	return {
		engine: {
			type: 'qwen',
			provider,
			model: { id, name: displayName },
			account: { id: 0, name: '' },
		},
		limit: { input: contextLength ?? 0, output: 0 },
		modalities: {
			input: { text: true, image: false, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: {
			reasoning: !!reasoningControl,
			tools: true,
			structuredOutput: true,
			...(reasoningControl && { reasoningControl }),
		},
		cost: { input: 0, output: 0 },
	};
}
