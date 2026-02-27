import type { SDKMessageFormatter } from '$shared/types/database/schema';
import {
  shouldFilterMessage,
  extractToolUses,
  extractToolResults
} from './message-processor';
import { processToolMessage } from './tool-handler';

// Tool group for mapping tool_use with tool_result
export interface ToolGroup {
  toolUseMessage: SDKMessageFormatter;
  toolResultMessage: SDKMessageFormatter | null;
}

// Background bash session data
export interface BackgroundBashData {
  bashToolId: string;
  bashOutputs: any[];
}

// Processed message type
export type ProcessedMessage = SDKMessageFormatter;

// Group tool_use and tool_result messages together
export function groupMessages(messages: SDKMessageFormatter[]): {
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>
} {
  const groups: ProcessedMessage[] = [];
  const toolUseMap = new Map<string, ToolGroup>();

  messages.forEach(message => {
    // Skip messages that should be filtered
    if (shouldFilterMessage(message)) {
      return;
    }

    // Handle assistant messages with tool_use
    if (message.type === 'assistant' && 'message' in message && message.message?.content) {
      const toolUses = extractToolUses(message.message.content);

      if (toolUses.length > 0) {
        // Store tool_use messages for grouping
        toolUses.forEach((toolUse: any) => {
          if (toolUse.id) {
            toolUseMap.set(toolUse.id, {
              toolUseMessage: message,
              toolResultMessage: null
            });
          }
        });
        groups.push(message as ProcessedMessage);
      } else {
        groups.push(message as ProcessedMessage);
      }
    }
    // Handle user messages with tool_result
    else if (message.type === 'user' && 'message' in message && message.message?.content) {
      const toolResults = extractToolResults(message.message.content);

      if (toolResults.length > 0) {
        // Group tool_result with corresponding tool_use
        toolResults.forEach((toolResult: any) => {
          if (toolResult.tool_use_id && toolUseMap.has(toolResult.tool_use_id)) {
            const group = toolUseMap.get(toolResult.tool_use_id);
            if (group) {
              group.toolResultMessage = message;
            }
          }
        });
        // Don't add tool_result messages separately
      } else {
        // Regular user message
        groups.push(message as ProcessedMessage);
      }
    }
    // Include stream_event and other messages
    else {
      groups.push(message as ProcessedMessage);
    }
  });

  return { groups, toolUseMap };
}

// Add tool results to messages
export function embedToolResults(
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>
): ProcessedMessage[] {
  // Track background bash sessions
  const backgroundBashMap = trackBackgroundBashSessions(groups, toolUseMap);

  // Create combined messages with tool_use including $result property
  return groups.map(message => {
    if (message.type === 'assistant' && 'message' in message && message.message?.content) {
      const toolUses = extractToolUses(message.message.content);

      if (toolUses.length > 0) {
        const processedMessage = processToolMessage(
          message,
          toolUseMap,
          backgroundBashMap
        );
        return processedMessage;
      }
    }

    return message;
  });
}

// Track background bash sessions and their outputs
function trackBackgroundBashSessions(
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>
): Map<string, BackgroundBashData> {
  const backgroundBashMap = new Map<string, BackgroundBashData>();

  groups.forEach(message => {
    if (message.type === 'assistant' && 'message' in message && message.message?.content) {
      const contentArray = Array.isArray(message.message.content)
        ? message.message.content
        : [message.message.content];

      contentArray.forEach((item) => {
        if (typeof item === 'object' && item && 'type' in item && item.type === 'tool_use') {
          const toolUse = item as any;
          // Check for Bash with run_in_background
          if (toolUse.name === 'Bash' && toolUse.input &&
              typeof toolUse.input === 'object' &&
              'run_in_background' in toolUse.input &&
              toolUse.input.run_in_background) {
            trackBackgroundBash(toolUse, toolUseMap, backgroundBashMap);
          }
          // Collect all BashOutput results
          else if (toolUse.name === 'BashOutput' && toolUse.input &&
                   typeof toolUse.input === 'object' &&
                   'bash_id' in toolUse.input) {
            trackBashOutput(toolUse, toolUseMap, backgroundBashMap);
          }
        }
      });
    }
  });

  return backgroundBashMap;
}

function trackBackgroundBash(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): void {
  const toolId = item.id;
  if (!toolId || !toolUseMap.has(toolId)) return;

  const group = toolUseMap.get(toolId);
  if (!group?.toolResultMessage) return;

  const resultMessage = group.toolResultMessage as any;
  const resultContent = resultMessage.message ?
    (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];

  const toolResult = resultContent.find((resultItem: any) =>
    typeof resultItem === 'object' &&
    resultItem &&
    'type' in resultItem &&
    resultItem.type === 'tool_result' &&
    'tool_use_id' in resultItem &&
    resultItem.tool_use_id === toolId
  ) as any | undefined;

  if (toolResult?.content && typeof toolResult.content === 'string') {
    // Extract bash ID from "Command running in background with ID: xxxxx"
    const idMatch = toolResult.content.match(/Command running in background with ID:\s*(\w+)/);
    if (idMatch) {
      const bashId = idMatch[1];
      backgroundBashMap.set(bashId, {
        bashToolId: toolId,
        bashOutputs: []
      });
    }
  }
}

function trackBashOutput(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): void {
  const bashId = (item.input as any).bash_id as string;
  const toolId = item.id;

  if (!toolId || !toolUseMap.has(toolId)) return;

  const group = toolUseMap.get(toolId);
  if (!group?.toolResultMessage) return;

  const resultMessage = group.toolResultMessage as any;
  const resultContent = resultMessage.message ?
    (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];

  const toolResult = resultContent.find((resultItem: any) =>
    typeof resultItem === 'object' &&
    resultItem &&
    'type' in resultItem &&
    resultItem.type === 'tool_result' &&
    'tool_use_id' in resultItem &&
    resultItem.tool_use_id === toolId
  ) as any | undefined;

  if (toolResult && backgroundBashMap.has(bashId)) {
    const bashData = backgroundBashMap.get(bashId);
    if (bashData) {
      bashData.bashOutputs.push(toolResult);
    }
  }
}