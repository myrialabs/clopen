/**
 * Qwen credential JSON.
 *
 * `engine_accounts.credential` for Qwen accounts is stored as a JSON object
 * carrying the API key and the chosen provider preset (DashScope CN/INTL,
 * OpenRouter, Fireworks). Storing the preset per-account lets the user keep
 * e.g. one DashScope and one OpenRouter account side by side.
 *
 * Backward compat: pre-migration accounts stored the raw API key as a plain
 * string. `parseQwenCredential` handles both shapes; `serializeQwenCredential`
 * always writes the JSON form. Legacy `baseUrl` overrides on existing rows are
 * tolerated on read (then ignored) so old data doesn't crash on parse.
 */

import {
	DEFAULT_QWEN_PRESET,
	getQwenPreset,
	type QwenProviderPresetId,
} from './presets';

export interface QwenCredential {
	apiKey: string;
	preset: QwenProviderPresetId;
}

const VALID_PRESETS: QwenProviderPresetId[] = [
	'dashscope-cn',
	'dashscope-intl',
	'openrouter',
	'fireworks',
];

function coercePreset(value: unknown): QwenProviderPresetId {
	if (typeof value === 'string' && (VALID_PRESETS as string[]).includes(value)) {
		return value as QwenProviderPresetId;
	}
	return DEFAULT_QWEN_PRESET;
}

/**
 * Parse a stored credential string into the structured shape. Falls back to
 * the default preset when the credential is a raw API key (pre-migration)
 * or malformed JSON. A legacy `baseUrl` field is silently dropped.
 */
export function parseQwenCredential(stored: string | null | undefined): QwenCredential {
	if (!stored) {
		return { apiKey: '', preset: DEFAULT_QWEN_PRESET };
	}
	const trimmed = stored.trim();
	if (!trimmed.startsWith('{')) {
		return { apiKey: trimmed, preset: DEFAULT_QWEN_PRESET };
	}
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
		const preset = coercePreset(parsed.preset);
		return { apiKey, preset };
	} catch {
		// Malformed — treat the whole blob as the API key so the user can
		// at least see "auth failed" rather than "no account".
		return { apiKey: trimmed, preset: DEFAULT_QWEN_PRESET };
	}
}

export function serializeQwenCredential(cred: QwenCredential): string {
	return JSON.stringify({
		apiKey: cred.apiKey,
		preset: cred.preset,
	});
}

/**
 * Resolve the effective base URL for a credential — the preset's default URL.
 */
export function resolveQwenBaseUrl(cred: QwenCredential): string | null {
	const preset = getQwenPreset(cred.preset);
	return preset?.defaultBaseUrl ?? null;
}
