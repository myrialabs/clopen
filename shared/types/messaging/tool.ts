/**
 * Tool Types
 *
 * Defines all tool input/output interfaces for UI components.
 * Input types AND output types are imported from the official SDK.
 */

// ============================================================
// SDK Tool Input Types
// ============================================================

import type {
  AgentInput,
  AskUserQuestionInput,
  BashInput,
  TaskOutputInput,
  ConfigInput,
  EnterWorktreeInput,
  ExitPlanModeInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  ListMcpResourcesInput,
  McpInput,
  NotebookEditInput,
  ReadMcpResourceInput,
  TaskStopInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

// ============================================================
// SDK Tool Output Types
// ============================================================

import type {
  AgentOutput as SDKAgentOutput,
  AskUserQuestionOutput as SDKAskUserQuestionOutput,
  BashOutput as SDKBashOutput,
  ConfigOutput as SDKConfigOutput,
  EnterWorktreeOutput as SDKEnterWorktreeOutput,
  ExitPlanModeOutput as SDKExitPlanModeOutput,
  FileEditOutput as SDKFileEditOutput,
  FileReadOutput as SDKFileReadOutput,
  FileWriteOutput as SDKFileWriteOutput,
  GlobOutput as SDKGlobOutput,
  GrepOutput as SDKGrepOutput,
  ListMcpResourcesOutput as SDKListMcpResourcesOutput,
  NotebookEditOutput as SDKNotebookEditOutput,
  ReadMcpResourceOutput as SDKReadMcpResourceOutput,
  TaskStopOutput as SDKTaskStopOutput,
  TodoWriteOutput as SDKTodoWriteOutput,
  WebFetchOutput as SDKWebFetchOutput,
  WebSearchOutput as SDKWebSearchOutput
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

// Re-export SDK output types with consistent names
export type TaskOutput = SDKAgentOutput;
export type AskUserQuestionOutput = SDKAskUserQuestionOutput;
export type BashOutput = SDKBashOutput;
export type ConfigOutput = SDKConfigOutput;
export type EnterWorktreeOutput = SDKEnterWorktreeOutput;
export type ExitPlanModeOutput = SDKExitPlanModeOutput;
export type EditOutput = SDKFileEditOutput;
export type ReadOutput = SDKFileReadOutput;
export type WriteOutput = SDKFileWriteOutput;
export type GlobOutput = SDKGlobOutput;
export type GrepOutput = SDKGrepOutput;
export type ListMcpResourcesOutput = SDKListMcpResourcesOutput;
export type NotebookEditOutput = SDKNotebookEditOutput;
export type ReadMcpResourceOutput = SDKReadMcpResourceOutput;
export type TaskStopOutput = SDKTaskStopOutput;
export type TodoWriteOutput = SDKTodoWriteOutput;
export type WebFetchOutput = SDKWebFetchOutput;
export type WebSearchOutput = SDKWebSearchOutput;

/**
 * Union type for all possible tool outputs (SDK types)
 */
export type ToolOutput =
  | TaskOutput
  | AskUserQuestionOutput
  | BashOutput
  | ConfigOutput
  | EnterWorktreeOutput
  | ExitPlanModeOutput
  | EditOutput
  | ReadOutput
  | WriteOutput
  | GlobOutput
  | GrepOutput
  | ListMcpResourcesOutput
  | NotebookEditOutput
  | ReadMcpResourceOutput
  | TaskStopOutput
  | TodoWriteOutput
  | WebFetchOutput
  | WebSearchOutput;

// ============================================================
// Tool Result Type (for embedding in tool_use)
// ============================================================

export interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ============================================================
// Tool Metadata (set by chat service on stream end)
// ============================================================

export interface ToolMetadata {
  /** Tool was interrupted — stream ended (error/cancel/complete) before tool got its result */
  interrupted?: boolean;
}

// ============================================================
// Tool Input Types for UI Components
// ============================================================

export interface BashToolInput {
  type: 'tool_use';
  id: string;
  name: 'Bash';
  input: BashInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface BashOutputToolInput {
  type: 'tool_use';
  id: string;
  name: 'TaskOutput';
  input: TaskOutputInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface EditToolInput {
  type: 'tool_use';
  id: string;
  name: 'Edit';
  input: FileEditInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface ExitPlanModeToolInput {
  type: 'tool_use';
  id: string;
  name: 'ExitPlanMode';
  input: ExitPlanModeInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface GlobToolInput {
  type: 'tool_use';
  id: string;
  name: 'Glob';
  input: GlobInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface GrepToolInput {
  type: 'tool_use';
  id: string;
  name: 'Grep';
  input: GrepInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface TaskStopToolInput {
  type: 'tool_use';
  id: string;
  name: 'TaskStop';
  input: TaskStopInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface ListMcpResourcesToolInput {
  type: 'tool_use';
  id: string;
  name: 'ListMcpResources';
  input: ListMcpResourcesInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface NotebookEditToolInput {
  type: 'tool_use';
  id: string;
  name: 'NotebookEdit';
  input: NotebookEditInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface ReadMcpResourceToolInput {
  type: 'tool_use';
  id: string;
  name: 'ReadMcpResource';
  input: ReadMcpResourceInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface ReadToolInput {
  type: 'tool_use';
  id: string;
  name: 'Read';
  input: FileReadInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface TaskToolInput {
  type: 'tool_use';
  id: string;
  name: 'Task';
  input: AgentInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface TodoWriteToolInput {
  type: 'tool_use';
  id: string;
  name: 'TodoWrite';
  input: TodoWriteInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface WebFetchToolInput {
  type: 'tool_use';
  id: string;
  name: 'WebFetch';
  input: WebFetchInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface WebSearchToolInput {
  type: 'tool_use';
  id: string;
  name: 'WebSearch';
  input: WebSearchInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface WriteToolInput {
  type: 'tool_use';
  id: string;
  name: 'Write';
  input: FileWriteInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface AskUserQuestionToolInput {
  type: 'tool_use';
  id: string;
  name: 'AskUserQuestion';
  input: AskUserQuestionInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface ConfigToolInput {
  type: 'tool_use';
  id: string;
  name: 'Config';
  input: ConfigInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

export interface EnterWorktreeToolInput {
  type: 'tool_use';
  id: string;
  name: 'EnterWorktree';
  input: EnterWorktreeInput;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

// Sub-agent activity item for Agent tool display
export interface SubAgentActivity {
  type: 'tool_use' | 'text';
  toolName?: string;
  toolInput?: any;
  toolResult?: any;
  text?: string;
}

export interface AgentToolInput {
  type: 'tool_use';
  id: string;
  name: 'Agent';
  input: AgentInput;
  $result?: ToolResult;
  $subMessages?: SubAgentActivity[];
  metadata?: ToolMetadata;
}

export interface EnterPlanModeToolInput {
  type: 'tool_use';
  id: string;
  name: 'EnterPlanMode';
  input: Record<string, unknown>;
  $result?: ToolResult;
  metadata?: ToolMetadata;
}

/**
 * Skill tool input — manually defined (not from SDK).
 *
 * Neither @anthropic-ai/claude-agent-sdk nor @opencode-ai/sdk export a
 * SkillInput type. The shape is inferred from observed tool_use payloads
 * where `input.skill` is the slash-command name and `input.args` is an
 * optional argument string.
 */
export interface SkillToolInput {
  type: 'tool_use';
  id: string;
  name: 'Skill';
  input: {
    skill: string;
    args?: string;
  };
  $result?: ToolResult;
  /** Expanded skill prompt (from synthetic user message) */
  $skillPrompt?: string;
  metadata?: ToolMetadata;
}

// ============================================================
// Union of All Tool Input Types
// ============================================================

export type ToolInput =
  | BashToolInput
  | BashOutputToolInput
  | EditToolInput
  | ExitPlanModeToolInput
  | GlobToolInput
  | GrepToolInput
  | TaskStopToolInput
  | ListMcpResourcesToolInput
  | NotebookEditToolInput
  | ReadMcpResourceToolInput
  | ReadToolInput
  | TaskToolInput
  | TodoWriteToolInput
  | WebFetchToolInput
  | WebSearchToolInput
  | WriteToolInput
  | AskUserQuestionToolInput
  | ConfigToolInput
  | EnterWorktreeToolInput
  | AgentToolInput
  | EnterPlanModeToolInput
  | SkillToolInput;
