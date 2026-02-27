import type { SDKMessageFormatter } from '$shared/types/database/schema';
import type { ToolInput } from '$shared/types/messaging';

// Content that can be either single or array
export type MessageContentArray = any[] | any | string;

// Helper type guards
export function isToolUseBlock(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    (item as any).type === 'tool_use'
  );
}

export function isToolResultBlock(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    (item as any).type === 'tool_result'
  );
}

// Ensure content is always an array
export function normalizeContent(content: MessageContentArray): any[] {
  if (Array.isArray(content)) {
    return content;
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return [content];
}

// List of tool names that should include tool_result in content
export const TOOLS_WITH_RESULTS: ToolInput['name'][] = [
  'Bash',
  'TaskOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResources',
  'NotebookEdit',
  'ReadMcpResource',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write'
];

// Tools that should be hidden from display
export const HIDDEN_TOOLS: ToolInput['name'][] = [
  'TaskOutput',
  'TodoWrite'
];

// Check if a message should be filtered out
export function shouldFilterMessage(message: SDKMessageFormatter): boolean {
  // Skip system and result type messages
  if (message.type === 'system' || message.type === 'result') {
    return true;
  }

  // Filter out stream_event messages with no partial text
  if (message.type === 'stream_event') {
    if (!('partialText' in message) || !message.partialText) {
      return true;
    }
  }

  // Filter out assistant messages with no visible content
  if (message.type === 'assistant') {
    // No message property at all
    if (!('message' in message) || !message.message) {
      return true;
    }

    const content = message.message.content;

    // No content or falsy content
    if (!content) {
      return true;
    }

    if (Array.isArray(content)) {
      // Empty content array
      if (content.length === 0) {
        return true;
      }
      // Check if there's any meaningful visible content
      const hasNonEmptyText = content.some((item: any) =>
        item.type === 'text' && item.text && item.text.trim().length > 0
      );
      const hasToolUse = content.some((item: any) => item.type === 'tool_use');
      // Filter if no meaningful text and no tool_use blocks
      if (!hasNonEmptyText && !hasToolUse) {
        return true;
      }
    }
  }

  return false;
}

// Extract tool uses from message content
export function extractToolUses(content: MessageContentArray): any[] {
  const contentArray = normalizeContent(content);
  return contentArray.filter(isToolUseBlock);
}

// Extract tool results from message content
export function extractToolResults(content: MessageContentArray): any[] {
  const contentArray = normalizeContent(content);
  return contentArray.filter(isToolResultBlock);
}

// Check if a tool should have its result embedded
export function shouldEmbedResult(toolName: string): boolean {
  // Custom MCP tools always embed results (they start with 'mcp__')
  if (toolName.startsWith('mcp__')) {
    return true;
  }
  return TOOLS_WITH_RESULTS.includes(toolName as ToolInput['name']);
}

// Check if a tool should be hidden
export function shouldHideTool(toolName: string): boolean {
  return HIDDEN_TOOLS.includes(toolName as ToolInput['name']);
}