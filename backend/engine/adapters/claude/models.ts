/**
 * Claude Code model catalog.
 *
 * Static catalog — the Anthropic Agent SDK accepts these IDs directly via
 * the `model` option, no runtime discovery endpoint is needed. Update when
 * Anthropic ships a new generation.
 *
 * Only models with `Current state: Active` on
 * https://platform.claude.com/docs/en/about-claude/model-deprecations are
 * listed here, and of those only the ones whose retirement is not imminent —
 * deprecated, retired and about-to-retire models are dropped, never listed as
 * legacy.
 *
 * The bundled CLI decides what a model can actually do: the pinned SDK ships
 * the CLI binary, and that binary carries its own model table (capabilities
 * `effort`, `xhigh_effort`, `adaptive_thinking`, `rejects_disabled_thinking`).
 * A slug the CLI does not know fails at runtime, and a reasoning level the
 * model does not support is silently rewritten — so both the slugs and the
 * per-model levels below are taken from that table (CLI 2.1.296).
 */

import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';

/**
 * Claude's reasoning knob is the Agent SDK `effort` option plus `thinking`.
 * `off` disables thinking; `auto` is adaptive thinking (Claude decides — the
 * historical default); the rest are the SDK's native `EffortLevel` values.
 * The stream adapter translates the chosen token.
 *
 * Levels are per-model because the CLI rewrites what a model cannot take
 * instead of failing: `off` becomes adaptive thinking on models that reject
 * disabled thinking, `effort` is dropped on models without it, and `xhigh`
 * only exists from Opus 4.7 on. Offering those levels anyway put options in
 * the picker that did nothing.
 */
const ALWAYS_THINKING = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const FULL_EFFORT = ['off', ...ALWAYS_THINKING];
const EFFORT_TO_MAX = ['off', 'auto', 'low', 'medium', 'high', 'max'];
const THINKING_ONLY = ['off', 'auto'];

function claudeReasoning(levels: string[]): ReasoningControl {
	return { levels: toReasoningOptions(levels), default: 'auto' };
}

/** Shared shape for a Claude catalog entry; only id, limits, cost and reasoning vary. */
function claudeModel(
	id: string,
	name: string,
	limit: { input: number; output: number },
	cost: { input: number; output: number },
	reasoningLevels: string[],
): EngineModel {
	return {
		engine: {
			type: 'claude-code',
			provider: 'anthropic',
			model: { id, name },
			account: { id: 0, name: '' },
		},
		limit,
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: true },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: {
			reasoning: true,
			tools: true,
			structuredOutput: true,
			reasoningControl: claudeReasoning(reasoningLevels),
		},
		cost,
	};
}

const WINDOW_1M = { input: 1_000_000, output: 128_000 };
const WINDOW_200K = { input: 200_000, output: 64_000 };

/** Latest generation first, then legacy models newest to oldest. */
export const CLAUDE_CODE_MODELS: EngineModel[] = [
	claudeModel('claude-fable-5-1', 'Claude Fable 5.1', WINDOW_1M, { input: 10, output: 50 }, ALWAYS_THINKING),
	claudeModel('claude-opus-5-5', 'Claude Opus 5.5', WINDOW_1M, { input: 4, output: 20 }, ALWAYS_THINKING),
	claudeModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', WINDOW_1M, { input: 2, output: 10 }, ALWAYS_THINKING),
	// Haiku 5.5 is priced in tiers: $0.50 / $2.50 once a prompt passes 100K
	// tokens. Only the base tier is listed — the catalog cost is metadata, while
	// the cost shown for a chat is the CLI's own, which applies the tiers.
	claudeModel('claude-haiku-5-5', 'Claude Haiku 5.5', WINDOW_1M, { input: 0.1, output: 0.5 }, ALWAYS_THINKING),
	claudeModel('claude-fable-5', 'Claude Fable 5', WINDOW_1M, { input: 10, output: 50 }, ALWAYS_THINKING),
	claudeModel('claude-opus-5', 'Claude Opus 5', WINDOW_1M, { input: 5, output: 25 }, FULL_EFFORT),
	claudeModel('claude-sonnet-5', 'Claude Sonnet 5', WINDOW_1M, { input: 3, output: 15 }, FULL_EFFORT),
	claudeModel('claude-opus-4-8', 'Claude Opus 4.8', WINDOW_1M, { input: 5, output: 25 }, FULL_EFFORT),
	claudeModel('claude-opus-4-7', 'Claude Opus 4.7', WINDOW_1M, { input: 5, output: 25 }, FULL_EFFORT),
	claudeModel('claude-opus-4-6', 'Claude Opus 4.6', WINDOW_1M, { input: 5, output: 25 }, EFFORT_TO_MAX),
	claudeModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', WINDOW_1M, { input: 3, output: 15 }, EFFORT_TO_MAX),
	claudeModel('claude-opus-4-5', 'Claude Opus 4.5', WINDOW_200K, { input: 5, output: 25 }, THINKING_ONLY),
];

/**
 * Resolve the reasoning level to send for a turn: the requested level when that
 * model offers it, otherwise that model's own default.
 *
 * The picker only offers per-model levels, but a stored preference outlives a
 * catalog change — an `off` saved before Opus 5.5 lost it must not reach the
 * CLI, which would quietly run adaptive thinking under a label saying "Off".
 * A model outside the catalog (an alias such as `haiku`) has no known levels,
 * so its request passes through unchanged.
 */
export function resolveClaudeReasoning(modelId: string | undefined, requested: string | undefined): string | undefined {
	const control = CLAUDE_CODE_MODELS.find(m => m.engine.model.id === modelId)?.capabilities.reasoningControl;
	if (!control || requested === undefined) return requested;
	if (control.levels.some(level => level.value === requested)) return requested;
	return control.default;
}
