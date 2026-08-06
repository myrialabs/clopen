/**
 * Open Code dynamic model discovery.
 *
 * Open Code's `client.config.providers()` endpoint returns the active
 * provider/model catalog (Anthropic, OpenAI, Groq, etc. — whatever is
 * configured server-side). We translate that response into `EngineModel[]`
 * preserving full modality and capability metadata exposed by the SDK.
 *
 * Returns `[]` on any failure (network, auth, malformed body) — the
 * picker simply renders empty rather than a stale curated list.
 */

import type { EngineModel } from '$shared/types/unified';
import type { OpencodeClient, Provider, Model } from '@opencode-ai/sdk';
import { debug } from '$shared/utils/logger';

export async function fetchOpenCodeModels(client: OpencodeClient): Promise<EngineModel[]> {
	try {
		const response = await client.config.providers();
		const providers: Provider[] = response.data?.providers ?? [];
		const models: EngineModel[] = [];

		for (const provider of providers) {
			const providerModels: Record<string, Model> = provider.models ?? {};
			const modelOrder = (provider.options._modelOrder as string[]) ?? [];

			const entries = modelOrder.length > 0
				? [...Object.entries(providerModels)].sort((a, b) => {
					const ai = modelOrder.indexOf(a[0]);
					const bi = modelOrder.indexOf(b[0]);
					return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
				})
				: Object.entries(providerModels);

			for (const [, model] of entries) {
				models.push({
					engine: {
						type: 'opencode',
						provider: provider.id,
						model: {
							id: model.id,
							name: model.name,
						},
						account: {
							id: 0,
							name: '',
						},
					},
					limit: {
						input: model.limit.context,
						output: model.limit.output,
					},
					modalities: {
						input: {
							text: model.capabilities.input.text,
							image: model.capabilities.input.image,
							audio: model.capabilities.input.audio,
							video: model.capabilities.input.video,
							pdf: model.capabilities.input.pdf,
						},
						output: {
							text: model.capabilities.output.text,
							image: model.capabilities.output.image,
							audio: model.capabilities.output.audio,
							video: model.capabilities.output.video,
							pdf: model.capabilities.output.pdf,
						},
					},
					capabilities: {
						reasoning: model.capabilities.reasoning,
						tools: model.capabilities.toolcall,
						structuredOutput: true,
					},
					cost: {
						input: model.cost.input,
						output: model.cost.output,
					},
				});
			}
		}

		debug.log('engine', `Fetched ${models.length} models from ${providers.length} Open Code providers`);
		return models;
	} catch (error) {
		debug.error('engine', 'Failed to fetch Open Code providers:', error);
		return [];
	}
}
