import {
  shouldEmbedResult,
  shouldHideTool
} from './message-processor';
import type {
  ProcessedMessage,
  ToolGroup,
  BackgroundBashData
} from './message-grouper';

// Extended ToolUse with embedded result
export interface ToolUseWithResult {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
  $result?: any;
}

// Process a tool message with embedded results
export function processToolMessage(
  message: ProcessedMessage,
  toolUseMap: Map<string, ToolGroup>,
  backgroundBashMap: Map<string, BackgroundBashData>
): ProcessedMessage {
  const messageAny = message as any;
  const content = messageAny.message?.content ?
    (Array.isArray(messageAny.message.content) ? messageAny.message.content : [messageAny.message.content]) : [];

  // Create modified content with embedded tool_result in tool_use objects
  const modifiedContent = content
    .map((item: any): any => {
      if (typeof item === 'object' && item && 'type' in item && item.type === 'tool_use') {
        return processToolUse(item, toolUseMap, backgroundBashMap);
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
  backgroundBashMap: Map<string, BackgroundBashData>
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

  // Regular tool handling
  if (item.id && item.name && shouldEmbedResult(item.name) && toolUseMap.has(item.id)) {
    return handleRegularTool(item, toolUseMap);
  }

  return item;
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