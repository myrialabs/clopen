import type { SDKMessageFormatter } from '$shared/types/database/schema';
import {
  shouldFilterMessage,
  extractToolUses,
  extractToolResults,
  isCompactBoundaryMessage,
  isSyntheticUserMessage
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

// Module-level map for compact summary lookup (rebuilt each groupMessages call)
let _compactSummaryMap = new WeakMap<SDKMessageFormatter, string>();

// Lookup compact summary for a given compact_boundary message
export function getCompactSummary(message: SDKMessageFormatter): string | undefined {
  return _compactSummaryMap.get(message);
}

// Extract text content from a user message
function extractUserTextContent(message: SDKMessageFormatter): string {
  if (!('message' in message) || !message.message?.content) return '';
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => typeof item === 'object' && item?.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
  }
  return '';
}

// Get parent_tool_use_id from any message type
function getParentToolUseId(message: SDKMessageFormatter): string | null {
  if ('parent_tool_use_id' in message) {
    return (message as any).parent_tool_use_id ?? null;
  }
  return null;
}

// Group tool_use and tool_result messages together
export function groupMessages(messages: SDKMessageFormatter[]): {
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, SDKMessageFormatter[]>,
  skillPromptMap: Map<string, string>
} {
  const groups: ProcessedMessage[] = [];
  const toolUseMap = new Map<string, ToolGroup>();
  const agentToolUseIds = new Set<string>();
  const subAgentMap = new Map<string, SDKMessageFormatter[]>();
  const skillToolUseIds = new Set<string>();
  const skillPromptMap = new Map<string, string>();
  let lastCompactBoundaryIdx = -1;
  // Track last Skill tool_use ID for associating synthetic user messages
  let lastSkillToolUseId: string | null = null;

  // Rebuild compact summary map each call
  _compactSummaryMap = new WeakMap<SDKMessageFormatter, string>();

  messages.forEach(message => {
    // Skip messages that should be filtered
    if (shouldFilterMessage(message)) {
      return;
    }

    // Intercept ALL sub-agent messages (any parent_tool_use_id !== null)
    // before normal processing — these belong to Agent tool sub-conversations
    const parentToolId = getParentToolUseId(message);
    if (parentToolId) {
      if (agentToolUseIds.has(parentToolId)) {
        if (!subAgentMap.has(parentToolId)) {
          subAgentMap.set(parentToolId, []);
        }
        subAgentMap.get(parentToolId)!.push(message);
      }
      // Don't add any sub-agent message to main groups
      return;
    }

    // Handle compact boundary messages — track for synthetic user embedding
    if (isCompactBoundaryMessage(message)) {
      lastCompactBoundaryIdx = groups.length;
      lastSkillToolUseId = null;
      groups.push(message as ProcessedMessage);
      return;
    }

    // Handle assistant messages with tool_use
    if (message.type === 'assistant' && 'message' in message && message.message?.content) {
      lastCompactBoundaryIdx = -1;
      lastSkillToolUseId = null;
      const toolUses = extractToolUses(message.message.content);

      if (toolUses.length > 0) {
        // Store tool_use messages for grouping
        toolUses.forEach((toolUse: any) => {
          if (toolUse.id) {
            toolUseMap.set(toolUse.id, {
              toolUseMessage: message,
              toolResultMessage: null
            });
            // Track Agent tool IDs for sub-agent message collection
            if (toolUse.name === 'Agent') {
              agentToolUseIds.add(toolUse.id);
            }
            // Track Skill tool IDs for synthetic user message capture
            if (toolUse.name === 'Skill') {
              skillToolUseIds.add(toolUse.id);
              lastSkillToolUseId = toolUse.id;
            }
          }
        });
        groups.push(message as ProcessedMessage);
      } else {
        groups.push(message as ProcessedMessage);
      }
      return;
    }

    // Handle user messages
    if (message.type === 'user' && 'message' in message && message.message?.content) {
      // Synthetic user messages (after compaction): store summary in WeakMap keyed by compact boundary message
      if (isSyntheticUserMessage(message) && lastCompactBoundaryIdx >= 0) {
        const compactMsg = groups[lastCompactBoundaryIdx];
        const summaryText = extractUserTextContent(message);
        if (summaryText) {
          _compactSummaryMap.set(compactMsg, summaryText);
        }
        lastCompactBoundaryIdx = -1;
        return;
      }

      // Synthetic user messages after Skill tool: capture expanded skill prompt
      if (isSyntheticUserMessage(message) && lastSkillToolUseId) {
        const promptText = extractUserTextContent(message);
        if (promptText) {
          skillPromptMap.set(lastSkillToolUseId, promptText);
        }
        lastSkillToolUseId = null;
        return;
      }

      lastCompactBoundaryIdx = -1;

      const toolResults = extractToolResults(message.message.content);
      if (toolResults.length > 0) {
        // Group tool_result with corresponding tool_use
        // Note: don't reset lastSkillToolUseId here — tool_result may precede
        // the synthetic skill prompt user message
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
        // Regular user message — reset skill tracking
        lastSkillToolUseId = null;
        groups.push(message as ProcessedMessage);
      }
      return;
    }

    // Include stream_event and other messages
    lastCompactBoundaryIdx = -1;
    lastSkillToolUseId = null;
    groups.push(message as ProcessedMessage);
  });

  return { groups, toolUseMap, subAgentMap, skillPromptMap };
}

// Add tool results to messages
export function embedToolResults(
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, SDKMessageFormatter[]>,
  skillPromptMap: Map<string, string>
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
          backgroundBashMap,
          subAgentMap,
          skillPromptMap
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
