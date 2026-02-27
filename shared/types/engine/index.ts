/**
 * Engine Types
 *
 * Shared type definitions for multi-engine AI support.
 * All engines normalize their output to Claude SDK format (SDKMessage)
 * so frontend and DB remain engine-agnostic.
 */

// Supported AI engine types
export type EngineType = 'claude-code' | 'opencode';

// Engine model definition (engine-aware)
export interface EngineModel {
	/** Unique compound ID: "claude-code:sonnet", "opencode:gpt-4o" */
	id: string;
	/** Which engine this model belongs to */
	engine: EngineType;
	/** Engine-specific model identifier: "sonnet", "gpt-4o" */
	modelId: string;
	/** Display name: "Claude Sonnet", "GPT-4o" */
	name: string;
	/** Provider: "anthropic", "openai", "google" */
	provider: string;
	/** Human-readable description */
	description: string;
	/** List of capability tags */
	capabilities: string[];
	/** Context window size in tokens */
	contextWindow: number;
	/** Model freshness category */
	category: 'latest' | 'stable' | 'legacy';
	/** Whether this model is the recommended default */
	recommended?: boolean;
}

// Engine metadata for UI display
export interface EngineInfo {
	type: EngineType;
	name: string;
	description: string;
	icon: {
		light: string;
		dark: string;
	}
}
