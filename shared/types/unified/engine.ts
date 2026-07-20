/**
 * Engine Types
 *
 * Shared type definitions for multi-engine AI support.
 * EngineModel uses MessageEngine for identity, keeping all engine
 * context in a single unified structure.
 */

import type { MessageEngine } from './message';

// Re-export EngineType from common (canonical source)
export type { EngineType } from './common';

// Engine model definition
export interface EngineModel {
	engine: MessageEngine;

	limit: {
		input: number;
		output: number;
	};

	modalities: {
		input: {
			text: boolean;
			image: boolean;
			audio: boolean;
			video: boolean;
			pdf: boolean;
		};
		output: {
			text: boolean;
			image: boolean;
			audio: boolean;
			video: boolean;
			pdf: boolean;
		};
	};

	capabilities: {
		reasoning: boolean;
		tools: boolean;
		structuredOutput: boolean;
		/**
		 * Auth modes the model is compatible with. Models that require a
		 * ChatGPT (OAuth) login are flagged `'chatgpt'`; models that only
		 * accept API keys are flagged `'api_key'`. Models compatible with
		 * either mode leave this `undefined`.
		 *
		 * The chat input's account picker uses this to grey out models that
		 * the active Codex account can't reach.
		 */
		requiresAuthMode?: 'chatgpt' | 'api_key';
	};

	cost: {
		input: number;
		output: number;
	};
}

// Engine metadata for UI display
export interface EngineInfo {
	type: 'claude-code' | 'opencode' | 'copilot' | 'codex' | 'qwen' | 'pi';
	name: string;
	description: string;
	icon: {
		light: string;
		dark: string;
	}
}

// ── Qwen provider presets (wire format for `engine:qwen-presets-list`) ──
//
// Defined here so the frontend can stay typed without importing from
// `$backend`. The runtime values live in `backend/engine/adapters/qwen/presets.ts`.

export type QwenProviderPresetId =
	| 'dashscope-cn'
	| 'dashscope-intl'
	| 'openrouter'
	| 'fireworks';

export interface QwenProviderPreset {
	id: QwenProviderPresetId;
	name: string;
	defaultBaseUrl: string;
	docsUrl?: string;
}

// ── Pi provider presets (wire format for `engine:pi-presets-list`) ──
//
// Pi is genuinely multi-provider (Anthropic, OpenAI, Google, OpenRouter, xAI …).
// Each provider supports API-key auth, OAuth (subscription) auth, or both. The
// preset catalog is exposed to the login picker so the frontend can render the
// right flow per provider without importing `$backend`. Runtime values live in
// `backend/engine/adapters/pi/presets.ts`.

export type PiAuthMode = 'api_key' | 'oauth';

/**
 * One credential input a provider needs, shown up-front in the account form
 * (OpenCode-style). `role: 'key'` maps to the pi-ai `ApiKeyCredential.key`;
 * `role: 'env'` maps to `credential.env[key]` (provider-scoped config such as
 * `CLOUDFLARE_ACCOUNT_ID`).
 */
export interface PiCredentialField {
	key: string;
	label: string;
	secret: boolean;
	role: 'key' | 'env';
	placeholder?: string;
}

export interface PiProviderPreset {
	/** Provider id as pi-ai knows it (e.g. 'anthropic', 'openai', 'google'). */
	id: string;
	/** Human-facing provider name. */
	name: string;
	/** Which auth flows this provider supports. */
	authModes: PiAuthMode[];
	/** API-key credential fields to render (present when `authModes` includes 'api_key'). */
	fields?: PiCredentialField[];
	/** Label shown for the OAuth (subscription) option, when applicable. */
	oauthLabel?: string;
	/** Where to obtain an API key. */
	apiKeyUrl?: string;
}
