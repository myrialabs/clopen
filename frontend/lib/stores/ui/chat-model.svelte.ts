/**
 * Chat Model State Store
 *
 * Holds the local engine/model selection for the chat input.
 * Isolated from Settings — Settings only provides the initial default.
 * Changes here do NOT persist to Settings, and Settings changes do NOT
 * affect the current session's selection after the first message is sent.
 */

import { DEFAULT_ENGINE, DEFAULT_MODEL } from '$shared/constants/engines';
import type { EngineType } from '$shared/types/engine';

interface ChatModelState {
	engine: EngineType;
	model: string;
	engineModelMemory: Record<string, string>;
	claudeAccountId: number | null;
}

// Local reactive state — starts from compile-time defaults.
// Initialized from Settings on each new session via initChatModel().
export const chatModelState = $state<ChatModelState>({
	engine: DEFAULT_ENGINE,
	model: DEFAULT_MODEL,
	engineModelMemory: { 'claude-code': DEFAULT_MODEL },
	claudeAccountId: null
});

/**
 * Initialize the local chat model state from Settings defaults.
 * Called when a new session starts (no messages yet).
 */
export function initChatModel(
	engine: EngineType,
	model: string,
	memory: Record<string, string>
): void {
	chatModelState.engine = engine;
	chatModelState.model = model;
	chatModelState.engineModelMemory = { ...memory };
	// claudeAccountId will be set by EngineModelPicker after fetching accounts
	chatModelState.claudeAccountId = null;
}

/**
 * Restore the local chat model state from a session's persisted engine/model.
 * Called when continuing an existing session (has messages).
 * IMPORTANT: Must NOT read from chatModelState to avoid circular tracking in $effect.
 */
export function restoreChatModelFromSession(
	engine: EngineType,
	model: string,
	claudeAccountId?: number | null
): void {
	chatModelState.engine = engine;
	chatModelState.model = model;
	// Only set the current engine's model — avoids reading chatModelState.engineModelMemory
	// which would cause UpdatedAtError in Svelte 5 $effect tracking
	chatModelState.engineModelMemory = { [engine]: model };
	chatModelState.claudeAccountId = claudeAccountId ?? null;
}
