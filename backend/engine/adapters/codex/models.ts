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
 * retires 2026-08-31). `gpt-5.2` and `gpt-5.3-codex-spark` are dropped too —
 * both are gone from the shipped table and learn.chatgpt.com/docs/models no
 * longer mentions either (the docs used to carve `-spark` out as a ChatGPT
 * Pro-only exception, but that's no longer true).
 *
 * `gpt-daybreak-blue-latest`/`gpt-daybreak-red-latest` (specialized
 * defensive/offensive cybersecurity-research variants) and
 * `codex-auto-review` (an internal approval-review model) are in the shipped
 * table but marked `visibility: "hide"` there, so they're deliberately left
 * out of this picker too.
 *
 * Every entry also carries a `minimal_client_version`. The GPT-6 family needs
 * 0.153 (`gpt-6-astra`, `gpt-6.1-sol`) or 0.155 (`gpt-6-sol`, `gpt-6-luna`), so
 * this list must never run ahead of the pinned SDK: a model picked here that
 * the bundled CLI is too old for fails at runtime, not at type-check.
 *
 * Models tagged `requiresAuthMode` are filtered by the chat-input account
 * picker so the user can't pick a ChatGPT-only model while signed in with an
 * API key account (and vice versa).
 */

import type { ModelReasoningEffort } from '@openai/codex-sdk';
import type { EngineModel, ReasoningControl } from '$shared/types/unified';
import { toReasoningOptions } from '$shared/constants/engines';

/**
 * Codex's reasoning knob is the SDK `modelReasoningEffort` thread option. The
 * levels are per-model: the 5.6 and 6 families reach `max` or `ultra` above
 * `xhigh`, and `minimal` is no longer accepted by any current model.
 *
 * Typed against the SDK union so a level the SDK doesn't know is a compile
 * error here rather than a cast at the call site.
 */
const EFFORTS_TO_ULTRA: ModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORTS_TO_MAX: ModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_TO_XHIGH: ModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function codexReasoning(levels: ModelReasoningEffort[], fallback: ModelReasoningEffort): ReasoningControl {
	return { levels: toReasoningOptions(levels), default: fallback };
}

/**
 * The table carries two windows per model: `context_window` (272k, what the
 * CLI uses by default) and `max_context_window` (872k for the 5.6 and 6
 * families, 272k for `gpt-5.5`). Clopen runs every model at its max — see
 * `CODEX_CONTEXT_WINDOW_REQUEST` — so the catalog reports the max.
 */
const WINDOW_872K = 872_000;
const WINDOW_272K = 272_000;

/** Shared shape for a Codex catalog entry; `reasoning: null` = no reasoning knob. */
function codexModel(
	id: string,
	name: string,
	contextWindow: number,
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
		limit: { input: contextWindow, output: 128_000 },
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
	codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', WINDOW_872K, codexReasoning(EFFORTS_TO_ULTRA, 'low')),
	codexModel('gpt-6-astra', 'GPT-6-Astra', WINDOW_872K, codexReasoning(EFFORTS_TO_ULTRA, 'low')),
	codexModel('gpt-6-sol', 'GPT-6-Sol', WINDOW_872K, codexReasoning(EFFORTS_TO_ULTRA, 'medium')),
	codexModel('gpt-6-luna', 'GPT-6-Luna', WINDOW_872K, codexReasoning(EFFORTS_TO_MAX, 'medium')),
	codexModel('gpt-5.6-sol', 'GPT-5.6-Sol', WINDOW_872K, codexReasoning(EFFORTS_TO_ULTRA, 'low')),
	codexModel('gpt-5.6-terra', 'GPT-5.6-Terra', WINDOW_872K, codexReasoning(EFFORTS_TO_ULTRA, 'medium')),
	codexModel('gpt-5.6-luna', 'GPT-5.6-Luna', WINDOW_872K, codexReasoning(EFFORTS_TO_MAX, 'medium')),
	codexModel('gpt-5.5', 'GPT-5.5', WINDOW_272K, codexReasoning(EFFORTS_TO_XHIGH, 'medium')),
];

/**
 * The `model_context_window` sent to the CLI. Without it the CLI stays at each
 * model's 272k `context_window` even where the model reaches 872k.
 *
 * The SDK bakes `config` into the client once, while the model changes per
 * turn, so this is one value for every model: the largest window in the
 * catalog. That is sound because the CLI clamps the request to the active
 * model's `max_context_window` — verified against 0.159.3, where 872k on
 * `gpt-5.5` reported a 272k window and 2M on `gpt-5.6-luna` reported 872k
 * (each less the CLI's 5% reserve).
 */
export const CODEX_CONTEXT_WINDOW_REQUEST = Math.max(...CODEX_MODELS.map(model => model.limit.input));

/**
 * Resolve the `model_reasoning_effort` to send for a turn: the requested level
 * when that model accepts it, otherwise that model's own default, otherwise
 * `medium`.
 *
 * This is the only gate on the value. The picker offers per-model levels, but a
 * stored preference outlives a catalog change, so a level that is no longer
 * valid (`minimal`, or `ultra` on a model that caps at `max`) must not reach
 * the CLI — the SDK does not validate, it interpolates the value straight into
 * `--config model_reasoning_effort="…"`.
 */
export function resolveCodexEffort(modelId: string | undefined, requested: string | undefined): ModelReasoningEffort {
	const control = CODEX_MODELS.find(m => m.engine.model.id === modelId)?.capabilities.reasoningControl;
	const accepts = (value: string | undefined): value is ModelReasoningEffort =>
		value !== undefined && (control?.levels.some(level => level.value === value) ?? false);
	if (accepts(requested)) return requested;
	if (accepts(control?.default)) return control.default;
	return 'medium';
}
