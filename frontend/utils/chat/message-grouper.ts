import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import type {
  ToolUseBlock,
  ToolResult,
} from '$shared/types/unified';
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
  toolUseMessage: FrontendMessage;
  toolResultMessage: FrontendMessage | null;
}

// Background bash session data
export interface BackgroundBashData {
  bashToolId: string;
  bashOutputs: ToolResult[];
}

// Processed message type (same as FrontendMessage)
export type ProcessedMessage = FrontendMessage;

// Module-level map for compact summary lookup (rebuilt each groupMessages call)
let _compactSummaryMap = new WeakMap<FrontendMessage, string>();

// Lookup compact summary for a given compact_boundary message
export function getCompactSummary(message: FrontendMessage): string | undefined {
  return _compactSummaryMap.get(message);
}

// Extract text content from a user message
function extractUserTextContent(message: FrontendMessage): string {
  if (message.type !== 'user' || !('content' in message)) return '';
  return message.content
    .filter((item) => item.type === 'text')
    .map((item) => (item as any).text as string)
    .join('\n');
}

// Get parent.toolUseId from any message type
function getParentToolUseId(message: FrontendMessage): string | null {
  if ('parent' in message) {
    return (message as any).parent.toolUseId ?? null;
  }
  return null;
}

// Group tool_use and tool_result messages together
export function groupMessages(messages: FrontendMessage[]): {
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, FrontendMessage[]>,
  skillPromptMap: Map<string, string>
} {
  const groups: ProcessedMessage[] = [];
  const toolUseMap = new Map<string, ToolGroup>();
  const agentToolUseIds = new Set<string>();
  const subAgentMap = new Map<string, FrontendMessage[]>();
  const skillToolUseIds = new Set<string>();
  const skillPromptMap = new Map<string, string>();
  let lastCompactBoundaryIdx = -1;
  let lastSkillToolUseId: string | null = null;

  // Rebuild compact summary map each call
  _compactSummaryMap = new WeakMap<FrontendMessage, string>();

  messages.forEach(message => {
    // Skip messages that should be filtered
    if (shouldFilterMessage(message)) {
      return;
    }

    // Intercept ALL sub-agent messages (any parentToolUseId !== null)
    const parentToolId = getParentToolUseId(message);
    if (parentToolId) {
      if (agentToolUseIds.has(parentToolId)) {
        if (!subAgentMap.has(parentToolId)) {
          subAgentMap.set(parentToolId, []);
        }
        subAgentMap.get(parentToolId)!.push(message);
      }
      return;
    }

    // Handle compact boundary messages
    if (isCompactBoundaryMessage(message)) {
      lastCompactBoundaryIdx = groups.length;
      lastSkillToolUseId = null;
      groups.push(message);
      return;
    }

    // Handle assistant messages with tool_use
    if (message.type === 'assistant' && 'content' in message) {
      lastCompactBoundaryIdx = -1;
      lastSkillToolUseId = null;
      const toolUses = extractToolUses(message.content);

      if (toolUses.length > 0) {
        toolUses.forEach((toolUse) => {
          if (toolUse.id) {
            toolUseMap.set(toolUse.id, {
              toolUseMessage: message,
              toolResultMessage: null
            });
            if (toolUse.name === 'Agent') {
              agentToolUseIds.add(toolUse.id);
            }
            if (toolUse.name === 'Skill') {
              skillToolUseIds.add(toolUse.id);
              lastSkillToolUseId = toolUse.id;
            }
          }
        });
      }
      groups.push(message);
      return;
    }

    // Handle user messages
    if (message.type === 'user' && 'content' in message) {
      // Synthetic user messages (after compaction)
      if (isSyntheticUserMessage(message) && lastCompactBoundaryIdx >= 0) {
        const compactMsg = groups[lastCompactBoundaryIdx];
        const summaryText = extractUserTextContent(message);
        if (summaryText) {
          _compactSummaryMap.set(compactMsg, summaryText);
        }
        lastCompactBoundaryIdx = -1;
        return;
      }

      // Synthetic user messages after Skill tool
      if (isSyntheticUserMessage(message) && lastSkillToolUseId) {
        const promptText = extractUserTextContent(message);
        if (promptText) {
          skillPromptMap.set(lastSkillToolUseId, promptText);
        }
        lastSkillToolUseId = null;
        return;
      }

      lastCompactBoundaryIdx = -1;

      const toolResults = extractToolResults(message.content);
      if (toolResults.length > 0) {
        toolResults.forEach((toolResult) => {
          if (toolResult.toolUseId && toolUseMap.has(toolResult.toolUseId)) {
            const group = toolUseMap.get(toolResult.toolUseId);
            if (group) {
              group.toolResultMessage = message;
            }
          }
        });
        // Don't add tool_result messages separately
      } else {
        lastSkillToolUseId = null;
        groups.push(message);
      }
      return;
    }

    // Include stream_event, reasoning, and other messages
    lastCompactBoundaryIdx = -1;
    lastSkillToolUseId = null;
    groups.push(message);
  });

  return { groups, toolUseMap, subAgentMap, skillPromptMap };
}

// Embed tool results into assistant messages
export function embedToolResults(
  groups: ProcessedMessage[],
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, FrontendMessage[]>,
  skillPromptMap: Map<string, string>
): ProcessedMessage[] {
  // Track background bash sessions
  const backgroundBashMap = trackBackgroundBashSessions(groups, toolUseMap);

  return groups.map(message => {
    if (message.type === 'assistant' && 'content' in message) {
      const toolUses = extractToolUses(message.content);

      if (toolUses.length > 0) {
        return processToolMessage(
          message,
          toolUseMap,
          backgroundBashMap,
          subAgentMap,
          skillPromptMap
        );
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
    if (message.type !== 'assistant' || !('content' in message)) return;

    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;

      // Check for Bash with run_in_background
      if (block.name === 'Bash' && block.input &&
          typeof block.input === 'object' &&
          'run_in_background' in block.input &&
          (block.input as any).run_in_background) {
        trackBackgroundBash(block, toolUseMap, backgroundBashMap);
      }
      // Collect all TaskOutput results
      else if (block.name === 'TaskOutput' && block.input &&
               typeof block.input === 'object' &&
               'bash_id' in block.input) {
        trackBashOutput(block, toolUseMap, backgroundBashMap);
      }
    }
  });

  return backgroundBashMap;
}

function trackBackgroundBash(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): void {
  const toolId = block.id;
  if (!toolId || !toolUseMap.has(toolId)) return;

  const group = toolUseMap.get(toolId);
  if (!group?.toolResultMessage) return;

  const resultMsg = group.toolResultMessage;
  if (resultMsg.type !== 'user' || !('content' in resultMsg)) return;

  const toolResult = resultMsg.content.find(
    (item): item is ToolResult => item.type === 'tool_result' && item.toolUseId === toolId
  );

  if (toolResult?.content && typeof toolResult.content === 'string') {
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
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): void {
  const bashId = (block.input as any).bash_id as string;
  const toolId = block.id;

  if (!toolId || !toolUseMap.has(toolId)) return;

  const group = toolUseMap.get(toolId);
  if (!group?.toolResultMessage) return;

  const resultMsg = group.toolResultMessage;
  if (resultMsg.type !== 'user' || !('content' in resultMsg)) return;

  const toolResult = resultMsg.content.find(
    (item): item is ToolResult => item.type === 'tool_result' && item.toolUseId === toolId
  );

  if (toolResult && backgroundBashMap.has(bashId)) {
    const bashData = backgroundBashMap.get(bashId);
    if (bashData) {
      bashData.bashOutputs.push(toolResult);
    }
  }
}
