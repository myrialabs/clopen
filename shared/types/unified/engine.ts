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
	};

	cost: {
		input: number;
		output: number;
	};
}

// Engine metadata for UI display
export interface EngineInfo {
	type: 'claude-code' | 'opencode' | 'copilot';
	name: string;
	description: string;
	icon: {
		light: string;
		dark: string;
	}
}
