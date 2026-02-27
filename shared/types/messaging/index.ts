/**
 * Messaging Types
 *
 * HANYA re-export types resmi dari @anthropic-ai/claude-agent-sdk
 * TIDAK ada custom types - gunakan langsung dari SDK
 */

// ========================================
// RE-EXPORT OFFICIAL SDK TYPES ONLY
// ========================================

// Re-export all message types from Claude Agent SDK
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  Options,
  PermissionMode,
  ApiKeySource,
  ConfigScope,
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpSdkServerConfigWithInstance,
  Query,
  PermissionResult,
  CanUseTool,
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  BaseHookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  NotificationHookInput,
  UserPromptSubmitHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  SubagentStopHookInput,
  PreCompactHookInput,
  HookJSONOutput,
  AsyncHookJSONOutput,
  SyncHookJSONOutput,
  PermissionUpdate,
  PermissionBehavior,
  PermissionRuleValue,
  NonNullableUsage
} from '@anthropic-ai/claude-agent-sdk';

// Re-import SDKUserMessage for use in this file
import type { SDKUserMessage as _SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDKMessage enriched with engine metadata.
 * Used by engine adapters and stream-manager to carry reasoning flags etc.
 * without polluting the root with untyped properties like `_reasoning`.
 */
export type EngineSDKMessage = SDKMessage & {
  metadata?: {
    reasoning?: boolean;
  };
};

// Re-export the main query function and utilities
export { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// AbortError is a custom error class we can define if needed
export class AbortError extends Error {
  constructor(message: string = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

// Re-export content types from Anthropic SDK for message content
export type {
  ContentBlock,
  ContentBlockParam,
  TextBlock,
  TextBlockParam,
  ImageBlockParam,
  SearchResultBlockParam,
  ToolUseBlock,
  ToolResultBlockParam,
  Message as APIMessage,
  MessageParam as APIMessageParam,
  Usage
} from '@anthropic-ai/sdk/resources/messages';


import type { SDKMessage, SDKCompactBoundaryMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Usage } from '@anthropic-ai/sdk/resources/messages';

// Import content type statically
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';

// MessageContent type for UI components  
export type MessageContent = ContentBlock;

// Re-export tool types from tool.ts
export type {
  // Tool input types
  BashToolInput,
  BashOutputToolInput,
  EditToolInput,
  ExitPlanModeToolInput,
  GlobToolInput,
  GrepToolInput,
  KillShellToolInput,
  ListMcpResourcesToolInput,
  NotebookEditToolInput,
  ReadMcpResourceToolInput,
  ReadToolInput,
  TaskToolInput,
  TodoWriteToolInput,
  WebFetchToolInput,
  WebSearchToolInput,
  WriteToolInput,
  ToolInput,

  // Tool output types
  TaskOutput,
  BashOutput,
  BashOutputToolOutput,
  EditOutput,
  TextFileOutput,
  ImageFileOutput,
  PDFFileOutput,
  NotebookFileOutput,
  ReadOutput,
  GlobOutput,
  GrepOutput,
  GrepContentOutput,
  GrepFilesOutput,
  GrepCountOutput,
  WebFetchOutput,
  WebSearchOutput,
  WriteOutput,
  NotebookEditOutput,
  TodoWriteOutput,
  ExitPlanModeOutput,
  KillShellOutput,
  ListMcpResourcesOutput,
  ReadMcpResourceOutput,
  ToolOutput,

  // Tool result type
  ToolResult
} from './tool';

// ========================================
// STREAM EVENT TYPES
// ========================================

// Unified SSE event data type for both server and client
export interface SSEEventData {
  // Connection/Process info
  processId?: string;
  timestamp?: string;
  error?: string;

  // Message data
  message?: SDKMessage;
  usage?: Usage;

  // Database metadata (for message tracking)
  message_id?: string;
  parent_message_id?: string | null;

  // User/sender information for shared chat
  sender_id?: string;
  sender_name?: string;

  // Notification data
  notification?: {
    type: string;
    title: string;
    message: string;
    icon?: string;
  };

  // Compact boundary indicator
  compactBoundary?: {
    trigger: 'manual' | 'auto';
    preTokens: number;
  };

  // Partial message text (for streaming)
  partialText?: string;

  // Delta text for smooth typing effect
  deltaText?: string;

  // Event type for partial messages
  eventType?: 'start' | 'update' | 'end';

  // Engine that produced this message
  engine?: string;
}

export interface ClaudeStreamRequest {
  projectPath: string;
  projectId?: string; // Project ID for tracking
  prompt: string; // User prompt as string (will be converted to SDKUserMessage by server)
  messages?: Array<{ role: string; content: string }>;
  chatSessionId?: string; // Database session ID for persistence
  model?: string;
  temperature?: number;
  senderId?: string; // User ID for shared chat
  senderName?: string; // User name for display
  forkSession?: boolean; // Fork session instead of continuing (default: false)
}

// Model configuration (engine-aware)
export type { EngineModel } from '$shared/types/engine';

// File attachment interface
export interface FileAttachment {
  type: 'image' | 'document';
  data: string; // base64 encoded
  mediaType: string;
  fileName: string;
}

// Chat service configuration
export interface ChatServiceOptions {
  onLoadingTextChange?: (text: string) => void;
  onStreamStart?: (processId: string) => void;
  onStreamEnd?: () => void;
  onError?: (error: Error) => void;
  attachedFiles?: FileAttachment[];
}