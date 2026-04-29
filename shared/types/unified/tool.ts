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

export interface ExitWorktreeInput {
	keep?: boolean;
}

export interface ToolSearchInput {
	query: string;
	maxResults?: number;
}

export interface ScheduleWakeupInput {
	delaySeconds: number;
	reason: string;
	prompt: string;
}

export interface MonitorInput {
	bashId?: string;
	processId?: string;
	source?: string;
	until?: string;
	timeout?: number;
}

export interface PushNotificationInput {
	title: string;
	message: string;
	url?: string;
}

export interface RemoteTriggerInput {
	name?: string;
	payload?: Record<string, unknown>;
}

export interface CronCreateInput {
	name: string;
	schedule: string;
	prompt: string;
	description?: string;
}

export interface CronDeleteInput {
	id: string;
}

export interface CronListInput {
	filter?: string;
}

export interface PatchInput {
	filePath: string;
	patch: string;
}

export interface ListInput {
	path?: string;
	ignore?: string[];
}

export interface LspInput {
	operation: string;
	filePath?: string;
	line?: number;
	column?: number;
	symbol?: string;
}

// ============================================================
// Tool Input Map
// ============================================================

/**
 * Single source of truth for every canonical tool name accepted by the
 * chat UI. Any tool emitted by an engine adapter MUST normalize to one
 * of these names — otherwise the backend emits an `Unknown:*` marker
 * and the UI renders it as an error (no silent fallback).
 */
export interface ToolInputMap {
	// File operations
	Bash: BashInput;
	Read: ReadInput;
	Edit: EditInput;
	Write: WriteInput;
	Patch: PatchInput;
	NotebookEdit: NotebookEditInput;
	// Discovery
	Glob: GlobInput;
	Grep: GrepInput;
	List: ListInput;
	// Web
	WebFetch: WebFetchInput;
	WebSearch: WebSearchInput;
	// Planning & questions
	TodoWrite: TodoWriteInput;
	AskUserQuestion: AskUserQuestionInput;
	EnterPlanMode: EnterPlanModeInput;
	ExitPlanMode: ExitPlanModeInput;
	// Sub-agents & tasks
	Agent: AgentInput;
	TaskOutput: TaskOutputInput;
	TaskStop: TaskStopInput;
	// MCP
	ListMcpResources: ListMcpResourcesInput;
	ReadMcpResource: ReadMcpResourceInput;
	// Harness / workspace
	Config: ConfigInput;
	EnterWorktree: EnterWorktreeInput;
	ExitWorktree: ExitWorktreeInput;
	Skill: SkillInput;
	ToolSearch: ToolSearchInput;
	Lsp: LspInput;
	// Automation & notifications
	ScheduleWakeup: ScheduleWakeupInput;
	Monitor: MonitorInput;
	PushNotification: PushNotificationInput;
	RemoteTrigger: RemoteTriggerInput;
	CronCreate: CronCreateInput;
	CronDelete: CronDeleteInput;
	CronList: CronListInput;
}

export type KnownToolName = keyof ToolInputMap;
export type McpToolName = `mcp__${string}`;
/**
 * Placeholder name for a tool emitted by an engine adapter that does not
 * map to any canonical name. Adapters MUST wrap the original name (e.g.
 * `Unknown:weird_tool`) so the UI can render a visible error instead of
 * silently falling back to a generic box.
 */
export type UnknownToolName = `Unknown:${string}`;

/**
 * Runtime set of every canonical tool name. Kept in sync with `ToolInputMap`.
 * Use this in engine adapters to decide whether to emit the tool name as-is
 * or wrap it with the `Unknown:` prefix.
 */
export const CANONICAL_TOOL_NAMES = new Set<KnownToolName>([
	'Bash', 'Read', 'Edit', 'Write', 'Patch', 'NotebookEdit',
	'Glob', 'Grep', 'List',
	'WebFetch', 'WebSearch',
	'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
	'Agent', 'TaskOutput', 'TaskStop',
	'ListMcpResources', 'ReadMcpResource',
	'Config', 'EnterWorktree', 'ExitWorktree', 'Skill', 'ToolSearch', 'Lsp',
	'ScheduleWakeup', 'Monitor', 'PushNotification', 'RemoteTrigger',
	'CronCreate', 'CronDelete', 'CronList',
]);

/**
 * MCP tools that the UI renders via a canonical (non-`mcp__*`) component.
 *
 * Currently empty — kept as a hook so a future engine that surfaces a
 * canonical-equivalent tool through MCP (rather than its native SDK) can
 * collapse it without re-introducing the registry plumbing.
 */
const MCP_CANONICAL_OVERRIDES: Record<string, KnownToolName> = {};

/**
 * Normalize an arbitrary tool name emitted by an engine into a shape the UI
 * is guaranteed to handle:
 *   - canonical names pass through unchanged;
 *   - whitelisted `mcp__*` overrides collapse to their canonical equivalent
 *     (see MCP_CANONICAL_OVERRIDES);
 *   - other `mcp__*` names pass through unchanged;
 *   - anything else is wrapped as `Unknown:<original>` so the UI renders a
 *     visible error with a pointer to the fix (add to the registry).
 */
export function toCanonicalToolName(rawName: string): KnownToolName | McpToolName | UnknownToolName {
	if (rawName.startsWith('mcp__')) {
		const override = MCP_CANONICAL_OVERRIDES[rawName];
		if (override) return override;
		return rawName as McpToolName;
	}
	if (CANONICAL_TOOL_NAMES.has(rawName as KnownToolName)) return rawName as KnownToolName;
	return `Unknown:${rawName}` as UnknownToolName;
}

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

export interface UnknownToolUseBlock {
	type: 'tool_use';
	id: string;
	name: UnknownToolName;
	input: Record<string, unknown>;
	result: ToolResult | null;
	subActivities: SubAgentActivity[];
	skillPrompt: string | null;
	interrupted: boolean;
}

export type ToolUseBlock = KnownToolUseBlock | McpToolUseBlock | UnknownToolUseBlock;
