/**
 * Qwen Code dynamic model discovery.
 *
 * Each preset (DashScope CN/INTL, OpenRouter, Fireworks) exposes the
 * OpenAI-compatible `/models` endpoint. We hit it with the active account's
 * API key and translate the response into `EngineModel[]` with conservative
 * default metadata — the SDK only needs the model id to dispatch a stream,
 * so anything beyond that is best-effort UI hinting.
 *
 * Returns `[]` on any failure (network, auth, malformed body) so the caller
 * can surface an empty picker rather than a stale curated list — same shape
 * as OpenCode's `fetchOpenCodeModels` (see README §4.5).
 */

import type { EngineModel } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import type { QwenEnvResolution } from './environment';

const MODELS_FETCH_TIMEOUT_MS = 10_000;

interface OpenAiModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		context_length?: number;
		[key: string]: unknown;
	}>;
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
			mapped.push(mapQwenIdToEngineModel(entry.id, entry.name, entry.context_length));
		}
		return mapped;
	} catch (error) {
		debug.warn('engine', `Qwen /models fetch error: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function mapQwenIdToEngineModel(id: string, name?: string, contextLength?: number): EngineModel {
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
		capabilities: { reasoning: false, tools: true, structuredOutput: true },
		cost: { input: 0, output: 0 },
	};
}
