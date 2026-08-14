/**
 * Codex Engine model catalog.
 *
 * Static catalog — it mirrors the model preset table the Codex CLI ships with
 * (`@openai/codex`, read out of the shipped binary), cross-checked against
 * https://learn.chatgpt.com/docs/models.md. That table is the CLI's own source
 * of truth for slug, display name, context window and reasoning levels, so
 * re-read it on every SDK bump rather than transcribing docs by hand.
 *
 * Presence in that table decides membership here: `gpt-5.3-codex`, `gpt-5.4`
 * and `gpt-5.4-mini` left it in the 0.147 bump and are dropped (the 5.4 pair
 * retires 2026-08-31). `gpt-5.3-codex-spark` is the deliberate exception — the
 * CLI also fetches account-entitled models from the server, so its absence from
 * the shipped table is not evidence of removal, and the docs still list it for
 * ChatGPT Pro.
 *
 * Models tagged `requiresAuthMode` are filtered by the chat-input account
 * picker so the user can't pick a ChatGPT-only model while signed in with an
 * API key account (and vice versa).
 */

import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';

/**
 * Codex's reasoning knob is the `model_reasoning_effort` config value. The
 * levels are per-model now: the 5.6 family added `max` and `ultra` above
 * `xhigh`, and `minimal` is no longer accepted by any current model.
 *
 * `max` and `ultra` sit past the SDK's `ModelReasoningEffort` union, which
 * still stops at `xhigh` in 0.147 — see `resolveCodexEffort` for why sending
 * them anyway is sound.
 */
const EFFORTS_TO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORTS_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_TO_XHIGH = ['low', 'medium', 'high', 'xhigh'];

function codexReasoning(levels: string[], fallback: string): ReasoningControl {
	return { levels: toReasoningOptions(levels), default: fallback };
}

/** Shared shape for a Codex catalog entry; `reasoning: null` = no reasoning knob. */
function codexModel(
	id: string,
	name: string,
	reasoning: ReasoningControl | null,
	extra?: { image?: boolean; requiresAuthMode?: 'chatgpt' },
): EngineModel {
	return {
		engine: {
			type: 'codex',
			provider: 'openai',
			model: { id, name },
			account: { id: 0, name: '' },
		},
		// Every preset in the table reports a 272k context window.
		limit: { input: 272_000, output: 128_000 },
		modalities: {
			input: { text: true, image: extra?.image ?? true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: {
			reasoning: reasoning !== null,
			tools: true,
			structuredOutput: reasoning !== null,
			...(reasoning ? { reasoningControl: reasoning } : {}),
			...(extra?.requiresAuthMode ? { requiresAuthMode: extra.requiresAuthMode } : {}),
		},
		cost: { input: 0, output: 0 },
	};
}

/** Ordered by the CLI's own `priority` field, so the picker matches Codex's. */
export const CODEX_MODELS: EngineModel[] = [
	codexModel('gpt-5.6-sol', 'GPT-5.6-Sol', codexReasoning(EFFORTS_TO_ULTRA, 'low')),
	codexModel('gpt-5.6-terra', 'GPT-5.6-Terra', codexReasoning(EFFORTS_TO_ULTRA, 'medium')),
	codexModel('gpt-5.6-luna', 'GPT-5.6-Luna', codexReasoning(EFFORTS_TO_MAX, 'medium')),
	codexModel('gpt-5.5', 'GPT-5.5', codexReasoning(EFFORTS_TO_XHIGH, 'medium')),
	codexModel('gpt-5.2', 'GPT-5.2', codexReasoning(EFFORTS_TO_XHIGH, 'medium')),
	codexModel('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark (ChatGPT Pro)', null, {
		image: false,
		requiresAuthMode: 'chatgpt',
	}),
];

/**
 * Resolve the `model_reasoning_effort` to send for a turn: the requested level
 * when that model accepts it, otherwise that model's own default, otherwise
 * `medium`.
 *
 * This is the only gate on the value. The picker offers per-model levels, but a
 * stored preference outlives a catalog change, so a level that is no longer
 * valid (`minimal`, or `ultra` on a model that caps at `max`) must not reach
 * the CLI.
 *
 * The return type is deliberately `string`, not the SDK's
 * `ModelReasoningEffort`. That union still stops at `xhigh` in
 * @openai/codex-sdk 0.147 while the CLI it drives accepts
 * `none|minimal|low|medium|high|xhigh|max|ultra`, and the SDK does not validate
 * — it interpolates the value straight into
 * `--config model_reasoning_effort="…"` (`dist/index.js`). Narrowing to the
 * stale union would make `max` and `ultra`, the top levels of GPT-5.6 Sol and
 * Terra, unreachable from Clopen. The caller casts at the SDK boundary.
 */
export function resolveCodexEffort(modelId: string | undefined, requested: string | undefined): string {
	const control = CODEX_MODELS.find(m => m.engine.model.id === modelId)?.capabilities.reasoningControl;
	if (requested && control?.levels.some(level => level.value === requested)) return requested;
	return control?.default ?? 'medium';
}
