/**
 * Context Window Usage
 *
 * Calculates actual context window usage from assistant message token data.
 * Each API call sends the full conversation, so input_tokens on the last
 * assistant message represents total context consumed at that turn.
 */

import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import type { TokenUsage } from '$shared/types/unified';

const WARNING_THRESHOLD = 0.8;

export interface ContextUsage {
  current: number;
  max: number;
  percentage: number;
  nearLimit: boolean;
}

/**
 * Get context window usage from the last assistant message.
 *
 * Cache tokens (creation + read) also count toward the context window.
 */
export function getContextUsage(messages: FrontendMessage[], contextWindow: number): ContextUsage {
  // Find the last assistant message with usage data (iterate backwards)
  let lastUsage: TokenUsage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'assistant' && 'usage' in msg && msg.usage) {
      lastUsage = msg.usage;
      break;
    }
  }

  if (!lastUsage) {
    return { current: 0, max: contextWindow, percentage: 0, nearLimit: false };
  }

  const current = (lastUsage.inputTokens || 0)
    + (lastUsage.cacheCreationInputTokens || 0)
    + (lastUsage.cacheReadInputTokens || 0);

  const percentage = Math.min(100, Math.round((current / contextWindow) * 1000) / 10);

  return {
    current,
    max: contextWindow,
    percentage,
    nearLimit: current >= contextWindow * WARNING_THRESHOLD
  };
}
