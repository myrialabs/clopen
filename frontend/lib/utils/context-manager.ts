/**
 * Context Window Management (Simplified)
 *
 * NOTE: Claude SDK now handles context management internally with efficient resume.
 * This module is simplified to provide token counting utilities only.
 * The SDK's native context management with compact boundaries is more efficient.
 */

import type { SDKMessage } from '$shared/types/messaging';

// Configuration (for display purposes only - SDK handles actual limits)
const DISPLAY_MAX_TOKENS = 200000; // Display token limit
const WARNING_THRESHOLD = 0.8; // Warn when reaching 80% of max tokens
const TOKEN_ESTIMATE_RATIO = 3.5; // Estimate: 1 token ≈ 3.5 characters

export interface ManagedContext {
  messages: SDKMessage[];
  summary?: string;
  totalTokens: number;
  isCompressed: boolean;
  tokenUsage: {
    current: number;
    max: number;
    percentage: number;
    nearLimit: boolean;
  };
}

/**
 * Estimate token count for a text string
 * Uses a more sophisticated estimation that accounts for different text patterns
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  
  // More accurate estimation accounting for:
  // - Whitespace and punctuation
  // - Code blocks (different tokenization)
  // - Common patterns
  
  let adjustedLength = text.length;
  
  // Code blocks tend to have more tokens per character
  const codeBlockMatches = text.match(/```[\s\S]*?```/g);
  if (codeBlockMatches) {
    const codeLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
    // Code has ~1 token per 2.5 characters
    adjustedLength = adjustedLength - codeLength + (codeLength / 2.5);
  }
  
  // Account for whitespace - multiple spaces/newlines count as fewer tokens
  const whitespaceReduced = text.replace(/\s+/g, ' ').length;
  adjustedLength = Math.min(adjustedLength, whitespaceReduced * 1.2);
  
  // Apply base ratio with minimum of 1 token for non-empty text
  return Math.max(1, Math.ceil(adjustedLength / TOKEN_ESTIMATE_RATIO));
}

// Token calculation cache to prevent recalculation
const tokenCache = new Map<string, number>();

/**
 * Calculate total tokens for a set of messages using only actual token usage data
 * Returns 0 if no actual usage data is available (no estimates)
 */
export function calculateMessageTokens(messages: SDKMessage[]): number {
  if (!messages || messages.length === 0) return 0;
  
  // Only use actual token usage data from API responses
  const messagesWithUsage = messages.filter(msg => {
    if (msg.type === 'assistant' && 'message' in msg && msg.message.usage) {
      return true;
    }
    return false;
  });
  
  if (messagesWithUsage.length === 0) {
    // No actual usage data available - return 0 instead of estimates
    return 0;
  }
  
  // Calculate actual total tokens from API responses
  return messagesWithUsage.reduce((total, msg) => {
    if (msg.type === 'assistant' && 'message' in msg && msg.message.usage) {
      const usage = msg.message.usage;
      return total + (usage.input_tokens || 0) + (usage.output_tokens || 0);
    }
    return total;
  }, 0);
}

/**
 * Create a summary of older messages
 */
export function summarizeMessages(messages: SDKMessage[]): string {
  if (messages.length === 0) return '';
  
  // Group messages by role for better summarization
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  
  messages.forEach(msg => {
    if (msg.type === 'user' && 'message' in msg) {
      // Extract key points from user messages
      const content = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
      const keyPoints = extractKeyPoints(content);
      if (keyPoints) userMessages.push(keyPoints);
    } else if (msg.type === 'assistant' && 'message' in msg) {
      // Extract key actions/responses from assistant
      const content = Array.isArray(msg.message.content) 
        ? msg.message.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join(' ')
        : JSON.stringify(msg.message.content);
      const keyActions = extractKeyActions(content);
      if (keyActions) assistantMessages.push(keyActions);
    }
  });
  
  // Build summary
  const summaryParts: string[] = [];
  
  if (userMessages.length > 0) {
    summaryParts.push(`Previous user requests: ${userMessages.join('; ')}`);
  }
  
  if (assistantMessages.length > 0) {
    summaryParts.push(`Previous assistant actions: ${assistantMessages.join('; ')}`);
  }
  
  return summaryParts.join('\n');
}

/**
 * Extract key points from user messages
 */
function extractKeyPoints(content: string): string {
  // Handle both string and ContentBlock array formats
  const textContent = content;
  
  // Look for questions, commands, or important keywords
  const lines = textContent.split('\n').filter(line => line.trim());
  
  // Prioritize lines with questions or commands
  const importantLines = lines.filter(line => 
    line.includes('?') || 
    line.includes('please') || 
    line.includes('help') ||
    line.includes('create') ||
    line.includes('update') ||
    line.includes('fix') ||
    line.includes('implement') ||
    line.includes('add') ||
    line.includes('remove') ||
    line.includes('show') ||
    line.includes('explain')
  );
  
  if (importantLines.length > 0) {
    // Take first important line as summary
    return importantLines[0].substring(0, 100);
  }
  
  // Fallback to first line
  return lines[0]?.substring(0, 100) || '';
}

/**
 * Extract key actions from assistant messages
 */
function extractKeyActions(content: string): string {
  // Look for action indicators
  const actionPatterns = [
    /created (.+)/i,
    /updated (.+)/i,
    /implemented (.+)/i,
    /fixed (.+)/i,
    /added (.+)/i,
    /removed (.+)/i,
    /modified (.+)/i,
    /explained (.+)/i,
    /I will (.+)/i,
    /I have (.+)/i,
    /I've (.+)/i
  ];
  
  for (const pattern of actionPatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[0].substring(0, 100);
    }
  }
  
  // Look for code blocks as actions
  if (content.includes('```')) {
    return 'provided code implementation';
  }
  
  // Fallback to first line
  const firstLine = content.split('\n')[0];
  return firstLine?.substring(0, 100) || '';
}

/**
 * Calculate token usage statistics with smoothing
 */
function calculateTokenUsage(currentTokens: number): ManagedContext['tokenUsage'] {
  // Ensure non-negative values
  const safeTokens = Math.max(0, currentTokens);
  const percentage = Math.min(100, (safeTokens / DISPLAY_MAX_TOKENS) * 100);
  
  return {
    current: safeTokens,
    max: DISPLAY_MAX_TOKENS,
    percentage: Math.round(percentage * 10) / 10, // Round to 1 decimal place for smoother transitions
    nearLimit: safeTokens >= (DISPLAY_MAX_TOKENS * WARNING_THRESHOLD)
  };
}

/**
 * Get conversation context info (SDK handles actual context management)
 * @deprecated Use SDK's native context management with resume feature
 */
export function manageConversationContext(messages: SDKMessage[]): ManagedContext {
  if (messages.length === 0) {
    return {
      messages: [],
      totalTokens: 0,
      isCompressed: false,
      tokenUsage: calculateTokenUsage(0)
    };
  }

  // Calculate total tokens for display purposes
  const totalTokens = calculateMessageTokens(messages);

  // SDK handles context internally, we just return info for UI
  return {
    messages,
    summary: undefined,
    totalTokens,
    isCompressed: false,
    tokenUsage: calculateTokenUsage(totalTokens)
  };
}

/**
 * Build conversation prompt
 * @deprecated SDK handles prompt building internally with resume feature
 */
export function buildConversationPrompt(
  messages: SDKMessage[],
  currentPrompt: string,
  summary?: string
): string {
  // SDK handles this internally now, just return the prompt
  // This function is kept for backward compatibility
  return currentPrompt;
}