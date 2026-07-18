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
	type: 'claude-code' | 'opencode' | 'copilot' | 'codex' | 'qwen';
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

export interface UsageQuota {
	percentRemaining: number;
	quotaType: string; // e.g. 'Session', 'Weekly', 'Monthly', or model name/custom limit
	providerId: string;
	resetsAt: string | null; // ISO 8601 string
	resetText?: string;
}

export interface UsageSnapshot {
	providerId: string;
	quotas: UsageQuota[];
	capturedAt: string; // ISO 8601 string
	accountEmail?: string | null;
	accountOrganization?: string | null;
	accountTier?: string | null;
}

