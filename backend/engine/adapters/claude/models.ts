/**
 * Claude Code model catalog.
 *
 * Static catalog — the Anthropic Agent SDK accepts these IDs directly via
 * the `model` option, no runtime discovery endpoint is needed. Update when
 * Anthropic ships a new generation.
 */

import type { EngineModel } from '$shared/types/unified';

export const CLAUDE_CODE_MODELS: EngineModel[] = [
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
	{
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: {
				id: 'claude-opus-4-1',
				name: 'Claude Opus 4.1',
			},
			account: {
				id: 0,
				name: '',
			},
		},
		limit: {
			input: 200_000,
			output: 32_000,
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
			input: 15,
			output: 75,
		},
	},
];
