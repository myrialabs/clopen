/**
 * Cline dynamic model discovery.
 *
 * Cline resolves models from the `@cline/llms` catalog. We enumerate every
 * provider that has a stored Clopen account and translate its catalog models
 * into `EngineModel`s.
 *
 * `engine.provider` carries the Cline provider id (e.g. 'anthropic', 'openai')
 * so the chat's send path can resolve the matching account by provider. Returns
 * `[]` on any failure (mirrors the OpenCode/Qwen/Pi dynamic-catalog contract —
 * the picker renders empty rather than a stale list).
 */

import { Llms } from '@cline/sdk';
import type { EngineModel } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { getClineAccounts, parseClineCredential } from './credential';

type CatalogModel = Awaited<ReturnType<typeof Llms.getModelsForProvider>>[string];

export async function fetchClineModels(): Promise<EngineModel[]> {
	try {
		// Distinct providers that have at least one stored account.
		const providers = new Set<string>();
		for (const account of getClineAccounts()) {
			const parsed = parseClineCredential(account.credential);
			if (parsed) providers.add(parsed.provider);
		}

		const out: EngineModel[] = [];
		for (const providerId of providers) {
			let models: Record<string, CatalogModel>;
			try {
				models = await Llms.getModelsForProvider(providerId);
			} catch (error) {
				debug.warn('engine', `Cline: could not list models for provider "${providerId}": ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const [modelId, info] of Object.entries(models)) {
				out.push(mapClineModel(providerId, modelId, info));
			}
		}
		debug.log('engine', `Cline getAvailableModels: ${out.length} models across ${providers.size} provider(s)`);
		return out;
	} catch (error) {
		debug.warn('engine', `Cline model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function mapClineModel(providerId: string, modelId: string, info: CatalogModel): EngineModel {
	const caps = info.capabilities ?? [];
	const image = caps.includes('images');
	return {
		engine: {
			type: 'cline',
			provider: providerId,
			model: { id: modelId, name: info.name || modelId },
			account: { id: 0, name: '' },
		},
		limit: { input: info.contextWindow ?? 0, output: info.maxTokens ?? 0 },
		modalities: {
			input: { text: true, image, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: {
			reasoning: caps.includes('reasoning'),
			tools: caps.includes('tools'),
			structuredOutput: caps.includes('structured_output'),
		},
		cost: { input: info.pricing?.input ?? 0, output: info.pricing?.output ?? 0 },
	};
}
