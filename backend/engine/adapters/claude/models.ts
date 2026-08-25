/**
 * Claude Code model catalog.
 *
 * Static catalog — the Anthropic Agent SDK accepts these IDs directly via
 * the `model` option, no runtime discovery endpoint is needed. Update when
 * Anthropic ships a new generation.
 *
 * Only models with `Current state: Active` on
 * https://platform.claude.com/docs/en/about-claude/model-deprecations are
 * listed here — deprecated/retired models are dropped.
 */

import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';

/**
 * Claude's reasoning knob is the Agent SDK `effort` option plus `thinking`.
 * `off` disables thinking; `auto` is adaptive thinking (Claude decides — the
 * historical default); the rest are the SDK's native `EffortLevel` values
 * (`low | medium | high | xhigh | max`, silently downgraded on models that
 * don't support the higher tiers). Uniform across the catalog; the stream
 * adapter translates the chosen token.
 */
const CLAUDE_REASONING_CONTROL: ReasoningControl = {
	levels: toReasoningOptions(['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']),
	default: 'auto',
};

const CLAUDE_CODE_MODELS_BASE: EngineModel[] = [
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-fable-5',
				name: 'Claude Fable 5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 10,
			output: 50,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-5',
				name: 'Claude Opus 5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 5,
			output: 25,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-sonnet-5',
				name: 'Claude Sonnet 5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 3,
			output: 15,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-haiku-4-5',
				name: 'Claude Haiku 4.5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 200_000,
			output: 64_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 1,
			output: 5,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-4-8',
				name: 'Claude Opus 4.8',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 5,
			output: 25,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-4-7',
				name: 'Claude Opus 4.7',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 5,
			output: 25,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-4-6',
				name: 'Claude Opus 4.6',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 5,
			output: 25,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-sonnet-4-6',
				name: 'Claude Sonnet 4.6',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 1_000_000,
			output: 128_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 3,
			output: 15,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-sonnet-4-5',
				name: 'Claude Sonnet 4.5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 200_000,
			output: 64_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 3,
			output: 15,
		},
	},
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-4-5',
				name: 'Claude Opus 4.5',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 200_000,
			output: 64_000,
		},
		modalities: {
			input: {
				text: true,
				image: true,
				audio: false,
				video: false,
				pdf: true,
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
			reasoning: true,
			tools: true,
			structuredOutput: true,
		},
		cost: {
			input: 5,
			output: 25,
		},
	},
];

export const CLAUDE_CODE_MODELS: EngineModel[] = CLAUDE_CODE_MODELS_BASE.map((model) => ({
	...model,
	capabilities: { ...model.capabilities, reasoningControl: CLAUDE_REASONING_CONTROL },
}));
