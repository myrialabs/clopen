import {
  shouldEmbedResult,
  shouldHideTool
} from './message-processor';
import type {
  ProcessedMessage,
  ToolGroup,
  BackgroundBashData
} from './message-grouper';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import type {
  ToolUseBlock,
  ToolResult,
  SubAgentActivity,
  AssistantContentBlock,
} from '$shared/types/unified';

// Process a tool message with embedded results
export function processToolMessage(
  message: ProcessedMessage,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>,
  subAgentMap: Map<string, FrontendMessage[]>,
  skillPromptMap: Map<string, string> = new Map()
): ProcessedMessage {
  if (message.type !== 'assistant' || !('content' in message)) return message;

  // Create modified content with embedded tool results
  const modifiedContent = message.content
    .map((block): AssistantContentBlock | null => {
      if (block.type === 'tool_use') {
        return processToolUse(block, toolUseMap, backgroundBashMap, subAgentMap, skillPromptMap);
      }
      return block;
    })
    .filter((item): item is AssistantContentBlock => item !== null);

  return {
    ...message,
    content: modifiedContent
  };
}

// Process individual tool_use block
function processToolUse(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>,
  subAgentMap: Map<string, FrontendMessage[]>,
  skillPromptMap: Map<string, string>
): ToolUseBlock | null {
  // Hide certain tools completely
  if (shouldHideTool(block.name)) {
    return null;
  }

  // Special handling for Bash with run_in_background
  if (block.name === 'Bash' && block.input &&
      typeof block.input === 'object' &&
      'run_in_background' in block.input &&
      (block.input as any).run_in_background && block.id) {
    return handleBackgroundBash(block, toolUseMap, backgroundBashMap);
  }

  // Special handling for Agent tool — embed sub-agent activities
  if (block.name === 'Agent' && block.id && subAgentMap.has(block.id)) {
    return handleAgentTool(block, toolUseMap, subAgentMap);
  }

  // Special handling for Skill tool — embed expanded skill prompt
  if (block.name === 'Skill' && block.id && skillPromptMap.has(block.id)) {
    return handleSkillTool(block, toolUseMap, skillPromptMap);
  }

  // Regular tool handling
  if (block.id && block.name && shouldEmbedResult(block.name) && toolUseMap.has(block.id)) {
    return handleRegularTool(block, toolUseMap);
  }

  return block;
}

// Handle Agent tool — process sub-agent messages into activities
function handleAgentTool(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, FrontendMessage[]>
): ToolUseBlock {
  const subMessages = subAgentMap.get(block.id) || [];
  const activities = processSubAgentMessages(subMessages);

  // Also embed the result if available
  const result = findToolResultFromGroup(toolUseMap, block.id);

  return {
    ...block,
    result: result ?? block.result,
    subActivities: activities.length > 0 ? activities : block.subActivities,
  } as ToolUseBlock;
}

// Process sub-agent messages into a flat activity list
function processSubAgentMessages(messages: FrontendMessage[]): SubAgentActivity[] {
  const activities: SubAgentActivity[] = [];
  const toolResultMap = new Map<string, ToolResult>();

  // First pass: collect all tool_results from user messages
  for (const msg of messages) {
    if (msg.type !== 'user' || !('content' in msg)) continue;
    for (const item of msg.content) {
      if (item.type === 'tool_result') {
        toolResultMap.set(item.toolUseId, item);
      }
    }
  }

  // Second pass: build activity list from assistant messages
  for (const msg of messages) {
    if (msg.type !== 'assistant' || !('content' in msg)) continue;
    for (const item of msg.content) {
      if (item.type === 'tool_use') {
        activities.push({
          type: 'tool_use',
          name: item.name,
          input: item.input as Record<string, unknown>,
          result: toolResultMap.get(item.id) ?? null
        });
      } else if (item.type === 'text' && (item as any).text?.trim()) {
        activities.push({
          type: 'text',
          text: (item as any).text
        });
      }
    }
  }

  return activities;
}

// Handle Skill tool — embed expanded skill prompt
function handleSkillTool(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  skillPromptMap: Map<string, string>
): ToolUseBlock {
  const skillPrompt = skillPromptMap.get(block.id) || null;
  const result = findToolResultFromGroup(toolUseMap, block.id);

  return {
    ...block,
    result: result ?? block.result,
    skillPrompt: skillPrompt ?? block.skillPrompt,
  } as ToolUseBlock;
}

// Handle background bash commands
function handleBackgroundBash(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): ToolUseBlock {
  const result = findToolResultFromGroup(toolUseMap, block.id);
  if (!result?.content || typeof result.content !== 'string') return block;

  // Extract bash ID and check for BashOutput
  const idMatch = result.content.match(/Command running in background with ID:\s*(\w+)/);
  if (!idMatch) return block;

  const bashId = idMatch[1];
  const bashData = backgroundBashMap.get(bashId);

  if (bashData && bashData.bashOutputs.length > 0) {
    const lastOutput = bashData.bashOutputs[bashData.bashOutputs.length - 1];
    return {
      ...block,
      result: { ...result, content: lastOutput.content || "" }
    } as ToolUseBlock;
  } else {
    return {
      ...block,
      result: { ...result, content: "" }
    } as ToolUseBlock;
  }
}

// Handle regular tools
function handleRegularTool(
  block: ToolUseBlock,
  toolUseMap: Map<string, ToolGroup>
): ToolUseBlock {
  const result = findToolResultFromGroup(toolUseMap, block.id);
  if (result) {
    return { ...block, result } as ToolUseBlock;
  }
  return block;
}

// Helper to find tool result from a ToolGroup's result message
function findToolResultFromGroup(
  toolUseMap: Map<string, ToolGroup>,
  toolUseId: string
): ToolResult | null {
  const group = toolUseMap.get(toolUseId);
  if (!group?.toolResultMessage) return null;

  const resultMsg = group.toolResultMessage;
  if (resultMsg.type !== 'user' || !('content' in resultMsg)) return null;

  return resultMsg.content.find(
    (item): item is ToolResult => item.type === 'tool_result' && item.toolUseId === toolUseId
  ) ?? null;
}
