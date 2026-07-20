/**
 * Shared primitives used across the unified message system.
 */

/** Token consumption statistics for a message or session */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
}

/** Why the assistant stopped generating */
export type StopReason =
	| 'end_turn'
	| 'tool_use'
	| 'max_tokens'
	| 'interrupted';

/** Supported AI engine backends */
export type EngineType = 'claude-code' | 'opencode' | 'copilot' | 'codex' | 'qwen' | 'pi';
