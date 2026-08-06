/**
 * Codex Engine model catalog.
 *
 * Static catalog — sourced from https://developers.openai.com/codex/models.md
 * and pruned to the IDs the Codex CLI actually accepts via `--model`. Models
 * tagged with `requiresAuthMode` are filtered by the chat-input account
 * picker so the user can't pick a ChatGPT-only model while signed in with an
 * API key account (and vice versa). Update when OpenAI ships a new
 * generation.
 */

import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';

/**
 * Codex's reasoning knob is the SDK `modelReasoningEffort` thread option
 * (`minimal | low | medium | high | xhigh`). `medium` is the historical
 * default. Attached only to reasoning-capable models below.
 */
const CODEX_REASONING_CONTROL: ReasoningControl = {
	levels: toReasoningOptions(['minimal', 'low', 'medium', 'high', 'xhigh']),
	default: 'medium',
};

const CODEX_MODELS_BASE: EngineModel[] = [
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.4', name: 'GPT-5.4' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: true, tools: true, structuredOutput: true },
		cost: { input: 0, output: 0 },
	},
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: true, tools: true, structuredOutput: true },
		cost: { input: 0, output: 0 },
	},
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: true, tools: true, structuredOutput: true },
		cost: { input: 0, output: 0 },
	},
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.2', name: 'GPT-5.2' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: true, tools: true, structuredOutput: true },
		cost: { input: 0, output: 0 },
	},
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.5', name: 'GPT-5.5 (ChatGPT only)' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: true, tools: true, structuredOutput: true, requiresAuthMode: 'chatgpt' },
		cost: { input: 0, output: 0 },
	},
	{
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark (ChatGPT Pro)' },
			account: { id: 0, name: '' },
		},
		limit: { input: 200_000, output: 128_000 },
		modalities: {
			input: { text: true, image: false, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: { reasoning: false, tools: true, structuredOutput: false, requiresAuthMode: 'chatgpt' },
		cost: { input: 0, output: 0 },
	},
];

export const CODEX_MODELS: EngineModel[] = CODEX_MODELS_BASE.map((model) =>
	model.capabilities.reasoning
		? { ...model, capabilities: { ...model.capabilities, reasoningControl: CODEX_REASONING_CONTROL } }
		: model,
);
