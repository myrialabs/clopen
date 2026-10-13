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
 *
 * The catalog also lists models a chat turn cannot use (transcription, image /
 * speech / video generation — e.g. `vercel-ai-gateway`'s `flux-*` and
 * `*-transcribe-*`); `isClineChatModel` keeps those out of the picker.
 */

import type { Llms } from '@cline/sdk';
import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { getClineAccounts, parseClineCredential } from './credential';

export type CatalogModel = Awaited<ReturnType<typeof Llms.getModelsForProvider>>[string];

/**
 * Whether a catalog model can run a text chat turn. Mirrors the SDK's own
 * `supportsChatModalities` + `operation` gate (not re-exported by
 * `@cline/sdk`): missing metadata counts as chat for older catalog entries;
 * otherwise the model must take text in, give text out, and run as a
 * `language` operation.
 */
export function isClineChatModel(info: Pick<CatalogModel, 'operation' | 'modalities'>): boolean {
	if (info.operation && info.operation !== 'language') return false;
	const modalities = info.modalities;
	if (!modalities) return true;
	return modalities.input.includes('text') && modalities.output.includes('text');
}

/** The SDK's effort ladder, low → high (`REASONING_LEVELS` minus `none`). */
const CLINE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClineEffort = (typeof CLINE_EFFORTS)[number];

type ReasoningOptions = CatalogModel['reasoningOptions'];

/**
 * Per-model reasoning levels, from the catalog's `reasoningOptions`:
 *   - `off`  — thinking disabled; only where the model can turn it off (a
 *              `toggle` option, or `none` among its efforts).
 *   - `auto` — no knob sent; the SDK applies the model's own default.
 *   - `low`…`max` — the efforts the model advertises.
 *   - `on`   — thinking enabled, for toggle-only models with no effort tiers.
 * Budget-only models (`budget_tokens` alone, e.g. Claude Sonnet 4.5) get no
 * selector: the SDK has no level to map them to.
 */
function clineReasoningLevels(options: ReasoningOptions): string[] {
	if (!options?.length) return [];
	const toggle = options.some(o => o.type === 'toggle');
	const effortValues = new Set<string | null>(options.find(o => o.type === 'effort')?.values ?? []);
	const efforts = CLINE_EFFORTS.filter(e => effortValues.has(e));
	const levels: string[] = [];
	if (toggle || effortValues.has('none')) levels.push('off');
	levels.push('auto');
	levels.push(...efforts);
	if (efforts.length === 0 && toggle) levels.push('on');
	return levels.length > 1 ? levels : [];
}

export function buildClineReasoningControl(options: ReasoningOptions): ReasoningControl | undefined {
	const levels = clineReasoningLevels(options);
	if (levels.length === 0) return undefined;
	return { levels: toReasoningOptions(levels), default: 'auto' };
}

/** `Agent` config fields carrying a reasoning level. */
export interface ClineReasoningConfig {
	thinking?: boolean;
	reasoningEffort?: ClineEffort;
}

/**
 * Map a chosen level onto the `Agent` knobs. A level the model doesn't offer
 * (stale per-model memory, a model swapped under the chat) and `auto` both send
 * nothing, so the model's own default applies rather than an invented value.
 */
export function resolveClineReasoning(level: string | undefined, options: ReasoningOptions): ClineReasoningConfig {
	if (!level || !clineReasoningLevels(options).includes(level)) return {};
	if (level === 'off') return { thinking: false };
	if (level === 'on') return { thinking: true };
	if ((CLINE_EFFORTS as readonly string[]).includes(level)) return { reasoningEffort: level as ClineEffort };
	return {};
}

/** Catalog entry for one model, or undefined when the provider doesn't list it. */
export async function getClineModelInfo(providerId: string, modelId: string): Promise<CatalogModel | undefined> {
	try {
		const { Llms } = await loadEngineSdk<typeof import('@cline/sdk')>('cline', '@cline/sdk');
		return (await Llms.getModelsForProvider(providerId))[modelId];
	} catch (error) {
		debug.warn('engine', `Cline: could not read catalog entry for "${providerId}/${modelId}": ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export async function fetchClineModels(): Promise<EngineModel[]> {
	try {
		const { Llms } = await loadEngineSdk<typeof import('@cline/sdk')>('cline', '@cline/sdk');
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
				if (isClineChatModel(info)) out.push(mapClineModel(providerId, modelId, info));
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
	const reasoningControl = buildClineReasoningControl(info.reasoningOptions);
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
			...(reasoningControl && { reasoningControl }),
		},
		cost: { input: info.pricing?.input ?? 0, output: info.pricing?.output ?? 0 },
	};
}
