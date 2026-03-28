import {
  shouldEmbedResult,
  shouldHideTool
} from './message-processor';
import type {
  ProcessedMessage,
  ToolGroup,
  BackgroundBashData
} from './message-grouper';
import type { SDKMessageFormatter } from '$shared/types/database/schema';
import type { SubAgentActivity } from '$shared/types/messaging';

// Extended ToolUse with embedded result and metadata
export interface ToolUseWithResult {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
  $result?: any;
  $subMessages?: SubAgentActivity[];
  $skillPrompt?: string;
  metadata?: Record<string, unknown>;
}

// Process a tool message with embedded results
export function processToolMessage(
  message: ProcessedMessage,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>,
  subAgentMap: Map<string, SDKMessageFormatter[]>,
  skillPromptMap: Map<string, string> = new Map()
): ProcessedMessage {
  const messageAny = message as any;
  const content = messageAny.message?.content ?
    (Array.isArray(messageAny.message.content) ? messageAny.message.content : [messageAny.message.content]) : [];

  // Check if parent message is marked as interrupted
  const isInterrupted = !!(messageAny.metadata?.interrupted);

  // Create modified content with embedded tool_result in tool_use objects
  const modifiedContent = content
    .map((item: any): any => {
      if (typeof item === 'object' && item && 'type' in item && item.type === 'tool_use') {
        const processed = processToolUse(item, toolUseMap, backgroundBashMap, subAgentMap, skillPromptMap);
        // Propagate message-level interrupted flag to ALL tool_use blocks
        if (processed && isInterrupted) {
          return { ...processed, metadata: { ...processed.metadata, interrupted: true } };
        }
        return processed;
      }
      return item;
    })
    .filter((item: any) => item !== null); // Remove null items (hidden tools)

  // Return modified message with embedded tool_results
  return {
    ...message,
    message: {
      ...messageAny.message,
      content: modifiedContent
    }
  } as ProcessedMessage;
}

// Process individual tool_use item
function processToolUse(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>,
  subAgentMap: Map<string, SDKMessageFormatter[]>,
  skillPromptMap: Map<string, string>
): ToolUseWithResult | null {
  // Hide certain tools completely
  if (shouldHideTool(item.name)) {
    return null;
  }

  // Special handling for Bash with run_in_background
  if (item.name === 'Bash' && item.input &&
      typeof item.input === 'object' &&
      'run_in_background' in item.input &&
      item.input.run_in_background && item.id) {
    return handleBackgroundBash(item, toolUseMap, backgroundBashMap);
  }

  // Special handling for Agent tool — embed sub-agent activities
  if (item.name === 'Agent' && item.id && subAgentMap.has(item.id)) {
    return handleAgentTool(item, toolUseMap, subAgentMap);
  }

  // Special handling for Skill tool — embed expanded skill prompt
  if (item.name === 'Skill' && item.id && skillPromptMap.has(item.id)) {
    return handleSkillTool(item, toolUseMap, skillPromptMap);
  }

  // Regular tool handling
  if (item.id && item.name && shouldEmbedResult(item.name) && toolUseMap.has(item.id)) {
    return handleRegularTool(item, toolUseMap);
  }

  return item;
}

// Handle Agent tool — process sub-agent messages into activities
function handleAgentTool(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  subAgentMap: Map<string, SDKMessageFormatter[]>
): ToolUseWithResult {
  const subMessages = subAgentMap.get(item.id) || [];
  const activities = processSubAgentMessages(subMessages);

  // Also embed the $result if available
  let result: any = undefined;
  if (item.id && toolUseMap.has(item.id)) {
    const group = toolUseMap.get(item.id);
    if (group?.toolResultMessage) {
      const resultMessage = group.toolResultMessage as any;
      const resultContent = resultMessage.message ?
        (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];
      result = findToolResult(resultContent, item.id);
    }
  }

  return {
    ...item,
    ...(result ? { $result: result } : {}),
    ...(activities.length > 0 ? { $subMessages: activities } : {})
  } as ToolUseWithResult;
}

// Process sub-agent messages into a flat activity list
function processSubAgentMessages(messages: SDKMessageFormatter[]): SubAgentActivity[] {
  const activities: SubAgentActivity[] = [];
  const toolResultMap = new Map<string, any>();

  // First pass: collect all tool_results from user messages
  for (const msg of messages) {
    if (msg.type === 'user' && 'message' in msg && msg.message?.content) {
      const content = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
      for (const item of content) {
        if (typeof item === 'object' && item && item.type === 'tool_result' && item.tool_use_id) {
          toolResultMap.set(item.tool_use_id, item);
        }
      }
    }
  }

  // Second pass: build activity list from assistant messages
  for (const msg of messages) {
    if (msg.type === 'assistant' && 'message' in msg && msg.message?.content) {
      const content = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
      for (const item of content) {
        if (typeof item === 'object' && item) {
          if (item.type === 'tool_use') {
            activities.push({
              type: 'tool_use',
              toolName: item.name,
              toolInput: item.input,
              toolResult: toolResultMap.get(item.id) || undefined
            });
          } else if (item.type === 'text' && item.text?.trim()) {
            activities.push({
              type: 'text',
              text: item.text
            });
          }
        }
      }
    }
  }

  return activities;
}

// Handle Skill tool — embed expanded skill prompt
function handleSkillTool(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  skillPromptMap: Map<string, string>
): ToolUseWithResult {
  const skillPrompt = skillPromptMap.get(item.id);

  // Also embed the $result if available
  let result: any = undefined;
  if (item.id && toolUseMap.has(item.id)) {
    const group = toolUseMap.get(item.id);
    if (group?.toolResultMessage) {
      const resultMessage = group.toolResultMessage as any;
      const resultContent = resultMessage.message ?
        (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];
      result = findToolResult(resultContent, item.id);
    }
  }

  return {
    ...item,
    ...(result ? { $result: result } : {}),
    ...(skillPrompt ? { $skillPrompt: skillPrompt } : {})
  } as ToolUseWithResult;
}

// Handle background bash commands
function handleBackgroundBash(
  item: any,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): ToolUseWithResult {
  const group = toolUseMap.get(item.id);
  if (!group?.toolResultMessage) return item;

  const resultMessage = group.toolResultMessage as any;
  const resultContent = resultMessage.message ?
    (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];

  const toolResult = findToolResult(resultContent, item.id);

  if (!toolResult?.content || typeof toolResult.content !== 'string') return item;

  // Extract bash ID and check for BashOutput
  const idMatch = toolResult.content.match(/Command running in background with ID:\s*(\w+)/);
  if (!idMatch) return item;

  const bashId = idMatch[1];
  const bashData = backgroundBashMap.get(bashId);

  if (bashData && bashData.bashOutputs.length > 0) {
    // Use the last BashOutput result
    const lastOutput = bashData.bashOutputs[bashData.bashOutputs.length - 1];
    return {
      ...item,
      $result: {
        ...toolResult,
        content: lastOutput.content || ""
      }
    } as ToolUseWithResult;
  } else {
    // No BashOutput found, clear the content
    return {
      ...item,
      $result: {
        ...toolResult,
        content: ""
      }
    } as ToolUseWithResult;
  }
}

// Handle regular tools
function handleRegularTool(
  item: any,
  toolUseMap: Map<string, ToolGroup>
): ToolUseWithResult {
  const group = toolUseMap.get(item.id);
  if (!group || !group.toolResultMessage) return item;

  const resultMessage = group.toolResultMessage as any;
  const resultContent = resultMessage.message ?
    (Array.isArray(resultMessage.message.content) ? resultMessage.message.content : [resultMessage.message.content]) : [];

  const toolResult = findToolResult(resultContent, item.id);

  if (toolResult) {
    // Embed tool_result as $result property in tool_use object
    return {
      ...item,
      $result: toolResult
    } as ToolUseWithResult;
  }

  return item;
}

// Helper to find tool result by id
function findToolResult(
  content: any[],
  toolUseId: string
): any {
  return content.find((resultItem: any) =>
    typeof resultItem === 'object' &&
    resultItem !== null &&
    'type' in resultItem &&
    resultItem.type === 'tool_result' &&
    'tool_use_id' in resultItem &&
    resultItem.tool_use_id === toolUseId
  );
}
