/**
 * Tool types, tool input definitions, and ToolUseBlock.
 *
 * ToolUseBlock is the single canonical type for tool invocations —
 * it includes both the invocation data and display enrichment fields
 * (result, subActivities). When first created, enrichment fields are null/empty.
 * The message grouper populates them for UI rendering.
 */

// ============================================================
// Tool Input Types
// ============================================================

export interface BashInput {
	command: string;
	description?: string;
	timeout?: number;
	runInBackground?: boolean;
}

export interface ReadInput {
	filePath: string;
	offset?: number;
	limit?: number;
	pages?: string;
}

export interface EditInput {
	filePath: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
}

export interface WriteInput {
	filePath: string;
	content: string;
}

export interface GlobInput {
	pattern: string;
	path?: string;
}

export interface GrepInput {
	pattern: string;
	path?: string;
	glob?: string;
	outputMode?: 'content' | 'files_with_matches' | 'count';
	type?: string;
	headLimit?: number;
	offset?: number;
	multiline?: boolean;
	caseInsensitive?: boolean;
	beforeContext?: number;
	afterContext?: number;
	context?: number;
	lineNumbers?: boolean;
}

export interface WebFetchInput {
	url: string;
	prompt: string;
}

export interface WebSearchInput {
	query: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface AskUserQuestionInput {
	questions: AskUserQuestion[];
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: AskUserQuestionOption[];
	multiSelect: boolean;
}

export interface AskUserQuestionOption {
	label: string;
	description: string;
	markdown?: string;
}

export interface TodoWriteInput {
	todos: TodoItem[];
}

export interface TodoItem {
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	activeForm: string;
}

export interface AgentInput {
	prompt: string;
	description: string;
	subagentType: string;
	model?: string;
	maxTurns?: number;
	isolation?: 'worktree';
	runInBackground?: boolean;
	resume?: string;
}

export interface TaskOutputInput {
	taskId: string;
	block?: boolean;
	timeout?: number;
}

export interface TaskStopInput {
	taskId: string;
}

export interface NotebookEditInput {
	notebookPath: string;
	newSource: string;
	cellId?: string;
	cellType?: 'code' | 'markdown';
	editMode?: 'replace' | 'insert' | 'delete';
}

export interface ListMcpResourcesInput {
	server?: string;
}

export interface ReadMcpResourceInput {
	server: string;
	uri: string;
}

export interface ConfigInput {
	key: string;
	value?: string;
}

export interface EnterWorktreeInput {
	name?: string;
}

export interface EnterPlanModeInput {}

export interface ExitPlanModeInput {
	allowedPrompts?: ExitPlanModePrompt[];
}

export interface ExitPlanModePrompt {
	tool: string;
	prompt: string;
}

export interface SkillInput {
	skill: string;
	args?: string;
}

// ============================================================
// Tool Input Map
// ============================================================

/** Maps each known tool name to its strongly-typed input interface */
export interface ToolInputMap {
	Bash: BashInput;
	Read: ReadInput;
	Edit: EditInput;
	Write: WriteInput;
	Glob: GlobInput;
	Grep: GrepInput;
	WebFetch: WebFetchInput;
	WebSearch: WebSearchInput;
	TodoWrite: TodoWriteInput;
	Agent: AgentInput;
	AskUserQuestion: AskUserQuestionInput;
	TaskOutput: TaskOutputInput;
	TaskStop: TaskStopInput;
	NotebookEdit: NotebookEditInput;
	ListMcpResources: ListMcpResourcesInput;
	ReadMcpResource: ReadMcpResourceInput;
	Config: ConfigInput;
	EnterWorktree: EnterWorktreeInput;
	EnterPlanMode: EnterPlanModeInput;
	ExitPlanMode: ExitPlanModeInput;
	Skill: SkillInput;
}

export type KnownToolName = keyof ToolInputMap;
export type McpToolName = `mcp__${string}`;

// ============================================================
// Sub-Agent Activity (populated in Agent tool blocks)
// ============================================================

export interface SubAgentToolActivity {
	type: 'tool_use';
	name: string;
	input: Record<string, unknown>;
	result: ToolResult | null;
}

export interface SubAgentTextActivity {
	type: 'text';
	text: string;
}

export type SubAgentActivity =
	| SubAgentToolActivity
	| SubAgentTextActivity;

// ============================================================
// Tool Result
// ============================================================

/** Result of a tool execution, matched by toolUseId */
export interface ToolResult {
	type: 'tool_result';
	toolUseId: string;
	content: string;
	isError: boolean;
}

// ============================================================
// Tool Use Block
// ============================================================

/**
 * ToolUseBlock is the unified type for tool invocations in assistant messages.
 *
 * It includes enrichment fields (result, subActivities, etc.) directly.
 * These are null/empty when the message is first created from the engine,
 * and get populated by the message grouper when preparing for display.
 *
 * Discriminate on `name` to narrow the `input` type:
 * ```ts
 * if (block.name === 'Bash') {
 *   block.input.command; // BashInput
 * }
 * ```
 */
type KnownToolUseBlock = {
	[N in KnownToolName]: {
		type: 'tool_use';
		id: string;
		name: N;
		input: ToolInputMap[N];
		result: ToolResult | null;
		subActivities: SubAgentActivity[];
		skillPrompt: string | null;
		interrupted: boolean;
	};
}[KnownToolName];

export interface McpToolUseBlock {
	type: 'tool_use';
	id: string;
	name: McpToolName;
	input: Record<string, unknown>;
	result: ToolResult | null;
	subActivities: SubAgentActivity[];
	skillPrompt: string | null;
	interrupted: boolean;
}

export type ToolUseBlock = KnownToolUseBlock | McpToolUseBlock;
