/**
 * Tool Input Types
 *
 * Defines all tool input interfaces for UI components
 */

// Import tool input types statically
import type {
  BashInput,
  TaskOutputInput,
  FileEditInput,
  ExitPlanModeInput,
  GlobInput,
  GrepInput,
  KillShellInput,
  ListMcpResourcesInput,
  NotebookEditInput,
  ReadMcpResourceInput,
  FileReadInput,
  AgentInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  FileWriteInput
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

// Tool output types based on Claude Code SDK

/**
 * Output from Task tool execution
 */
export interface TaskOutput {
  /** Final result message from the subagent */
  result: string;
  /** Token usage statistics */
  usage?: {
    /** Number of input tokens consumed */
    input_tokens: number;
    /** Number of output tokens generated */
    output_tokens: number;
    /** Number of cache creation input tokens */
    cache_creation_input_tokens?: number;
    /** Number of cache read input tokens */
    cache_read_input_tokens?: number;
  };
  /** Total cost in USD for this task execution */
  total_cost_usd?: number;
  /** Execution duration in milliseconds */
  duration_ms?: number;
}

/**
 * Output from Bash tool execution
 */
export interface BashOutput {
  /** Combined stdout and stderr output */
  output: string;
  /** Exit code of the command */
  exitCode: number;
  /** Whether the command was killed due to timeout */
  killed?: boolean;
  /** Shell ID for background processes */
  shellId?: string;
}

/**
 * Output from BashOutput tool for monitoring background processes
 */
export interface BashOutputToolOutput {
  /** Output from the background process */
  output: string;
  /** Current status of the background process */
  status: 'running' | 'completed' | 'failed';
  /** Exit code if the process has completed */
  exitCode?: number;
}

/**
 * Output from Edit tool for file modifications
 */
export interface EditOutput {
  /** Confirmation message about the edit operation */
  message: string;
  /** Number of replacements made */
  replacements: number;
  /** Path to the edited file */
  file_path: string;
}

/**
 * Output when reading a text file
 */
export interface TextFileOutput {
  /** Text content of the file */
  content: string;
  /** Total number of lines in the file */
  total_lines: number;
  /** Number of lines returned (may be limited by offset/limit) */
  lines_returned: number;
}

/**
 * Output when reading an image file
 */
export interface ImageFileOutput {
  /** Base64-encoded image data */
  image: string;
  /** MIME type of the image */
  mime_type: string;
  /** File size in bytes */
  file_size: number;
}

/**
 * Output when reading a PDF file
 */
export interface PDFFileOutput {
  /** Array of pages with text and images */
  pages: Array<{
    /** Page number (1-indexed) */
    page_number: number;
    /** Extracted text from the page */
    text?: string;
    /** Images found on the page */
    images?: Array<{
      /** Base64-encoded image data */
      image: string;
      /** MIME type of the image */
      mime_type: string;
    }>;
  }>;
  /** Total number of pages in the PDF */
  total_pages: number;
}

/**
 * Output when reading a Jupyter notebook file
 */
export interface NotebookFileOutput {
  /** Array of notebook cells */
  cells: Array<{
    /** Type of the cell */
    cell_type: 'code' | 'markdown';
    /** Source code or markdown content */
    source: string;
    /** Cell outputs (for code cells) */
    outputs?: any[];
    /** Execution count (for code cells) */
    execution_count?: number;
  }>;
  /** Notebook metadata */
  metadata?: Record<string, any>;
}

/**
 * Union type for all possible Read tool outputs
 */
export type ReadOutput =
  | TextFileOutput
  | ImageFileOutput
  | PDFFileOutput
  | NotebookFileOutput;

/**
 * Output from Glob tool for file pattern matching
 */
export interface GlobOutput {
  /** Array of file paths matching the pattern */
  matches: string[];
  /** Number of matches found */
  count: number;
  /** Search directory used */
  search_path: string;
}

/**
 * Output from Grep tool for content searching (content mode)
 */
export interface GrepContentOutput {
  /** Matching lines with context */
  matches: Array<{
    /** File path where the match was found */
    file: string;
    /** Line number of the match (if available) */
    line_number?: number;
    /** Content of the matching line */
    line: string;
    /** Lines before the match (if -B or -C was used) */
    before_context?: string[];
    /** Lines after the match (if -A or -C was used) */
    after_context?: string[];
  }>;
  /** Total number of matches found */
  total_matches: number;
}

/**
 * Output from Grep tool for files mode
 */
export interface GrepFilesOutput {
  /** Files containing matches */
  files: string[];
  /** Number of files with matches */
  count: number;
}

/**
 * Output from Grep tool for count mode
 */
export interface GrepCountOutput {
  /** Match counts per file */
  counts: Array<{
    /** File path */
    file: string;
    /** Number of matches in this file */
    count: number;
  }>;
  /** Total matches across all files */
  total: number;
}

/**
 * Union type for all possible Grep outputs based on output_mode
 */
export type GrepOutput =
  | GrepContentOutput
  | GrepFilesOutput
  | GrepCountOutput;

/**
 * Output from WebFetch tool for web content retrieval
 */
export interface WebFetchOutput {
  /** AI model's response to the prompt */
  response: string;
  /** URL that was fetched */
  url: string;
  /** Final URL after redirects */
  final_url?: string;
  /** HTTP status code */
  status_code?: number;
}

/**
 * Output from WebSearch tool for web searching
 */
export interface WebSearchOutput {
  /** Array of search results */
  results: Array<{
    /** Title of the search result */
    title: string;
    /** URL of the search result */
    url: string;
    /** Snippet/description of the search result */
    snippet: string;
  }>;
  /** Total number of results found */
  total_results: number;
}

/**
 * Output from Write tool for file creation
 */
export interface WriteOutput {
  /** Confirmation message about the write operation */
  message: string;
  /** Path to the written file */
  file_path: string;
  /** Number of bytes written */
  bytes_written: number;
}

/**
 * Output from NotebookEdit tool for Jupyter notebook modifications
 */
export interface NotebookEditOutput {
  /** Confirmation message about the notebook edit */
  message: string;
  /** Type of edit performed */
  edit_type: 'replaced' | 'inserted' | 'deleted';
  /** ID of the edited cell (if applicable) */
  cell_id?: string;
  /** Total cells in notebook after edit */
  total_cells: number;
}

/**
 * Output from TodoWrite tool for task management
 */
export interface TodoWriteOutput {
  /** Confirmation message about the todo operation */
  message: string;
  /** Current todo statistics */
  stats: {
    /** Total number of todos */
    total: number;
    /** Number of pending todos */
    pending: number;
    /** Number of in-progress todos */
    in_progress: number;
    /** Number of completed todos */
    completed: number;
  };
}

/**
 * Output from ExitPlanMode tool
 */
export interface ExitPlanModeOutput {
  /** Confirmation message about exiting plan mode */
  message: string;
}

/**
 * Output from KillShell tool for terminating background processes
 */
export interface KillShellOutput {
  /** Confirmation message about killing the shell */
  message: string;
  /** ID of the killed shell */
  shell_id: string;
}

/**
 * Output from ListMcpResources tool for MCP resource listing
 */
export interface ListMcpResourcesOutput {
  /** Array of available MCP resources */
  resources: Array<{
    /** URI of the resource */
    uri: string;
    /** Name of the resource */
    name: string;
    /** Description of the resource */
    description?: string;
    /** MIME type of the resource */
    mimeType?: string;
    /** Server that provides this resource */
    server: string;
  }>;
  /** Total number of resources */
  total: number;
}

/**
 * Output from ReadMcpResource tool for MCP resource reading
 */
export interface ReadMcpResourceOutput {
  /** Resource contents (can be multiple if resource has multiple parts) */
  contents: Array<{
    /** URI of the resource */
    uri: string;
    /** MIME type of the resource */
    mimeType?: string;
    /** Text content (for text resources) */
    text?: string;
    /** Base64-encoded blob (for binary resources) */
    blob?: string;
  }>;
  /** Server that provided the resource */
  server: string;
}

/**
 * Union type for all possible tool outputs
 */
export type ToolOutput =
  | TaskOutput
  | BashOutput
  | BashOutputToolOutput
  | EditOutput
  | ReadOutput
  | GlobOutput
  | GrepOutput
  | WebFetchOutput
  | WebSearchOutput
  | WriteOutput
  | NotebookEditOutput
  | TodoWriteOutput
  | ExitPlanModeOutput
  | KillShellOutput
  | ListMcpResourcesOutput
  | ReadMcpResourceOutput;

// Tool result type for embedding in tool_use
export interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

// Tool input types for UI components
export interface BashToolInput {
  type: 'tool_use';
  id: string;
  name: 'Bash';
  input: BashInput;
  $result?: ToolResult;
}

export interface BashOutputToolInput {
  type: 'tool_use';
  id: string;
  name: 'TaskOutput';
  input: TaskOutputInput;
  $result?: ToolResult;
}

export interface EditToolInput {
  type: 'tool_use';
  id: string;
  name: 'Edit';
  input: FileEditInput;
  $result?: ToolResult;
}

export interface ExitPlanModeToolInput {
  type: 'tool_use';
  id: string;
  name: 'ExitPlanMode';
  input: ExitPlanModeInput;
  $result?: ToolResult;
}

export interface GlobToolInput {
  type: 'tool_use';
  id: string;
  name: 'Glob';
  input: GlobInput;
  $result?: ToolResult;
}

export interface GrepToolInput {
  type: 'tool_use';
  id: string;
  name: 'Grep';
  input: GrepInput;
  $result?: ToolResult;
}

export interface KillShellToolInput {
  type: 'tool_use';
  id: string;
  name: 'KillShell';
  input: KillShellInput;
  $result?: ToolResult;
}

export interface ListMcpResourcesToolInput {
  type: 'tool_use';
  id: string;
  name: 'ListMcpResources';
  input: ListMcpResourcesInput;
  $result?: ToolResult;
}

export interface NotebookEditToolInput {
  type: 'tool_use';
  id: string;
  name: 'NotebookEdit';
  input: NotebookEditInput;
  $result?: ToolResult;
}

export interface ReadMcpResourceToolInput {
  type: 'tool_use';
  id: string;
  name: 'ReadMcpResource';
  input: ReadMcpResourceInput;
  $result?: ToolResult;
}

export interface ReadToolInput {
  type: 'tool_use';
  id: string;
  name: 'Read';
  input: FileReadInput;
  $result?: ToolResult;
}

export interface TaskToolInput {
  type: 'tool_use';
  id: string;
  name: 'Task';
  input: AgentInput;
  $result?: ToolResult;
}

export interface TodoWriteToolInput {
  type: 'tool_use';
  id: string;
  name: 'TodoWrite';
  input: TodoWriteInput;
  $result?: ToolResult;
}

export interface WebFetchToolInput {
  type: 'tool_use';
  id: string;
  name: 'WebFetch';
  input: WebFetchInput;
  $result?: ToolResult;
}

export interface WebSearchToolInput {
  type: 'tool_use';
  id: string;
  name: 'WebSearch';
  input: WebSearchInput;
  $result?: ToolResult;
}

export interface WriteToolInput {
  type: 'tool_use';
  id: string;
  name: 'Write';
  input: FileWriteInput;
  $result?: ToolResult;
}

export type ToolInput =
  | BashToolInput | BashOutputToolInput | EditToolInput | ExitPlanModeToolInput
  | GlobToolInput | GrepToolInput | KillShellToolInput | ListMcpResourcesToolInput
  | NotebookEditToolInput
  | ReadMcpResourceToolInput | ReadToolInput | TaskToolInput | TodoWriteToolInput
  | WebFetchToolInput | WebSearchToolInput | WriteToolInput;