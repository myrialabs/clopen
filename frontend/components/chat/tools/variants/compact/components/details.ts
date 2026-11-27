/**
 * What a compact tool row shows when it is opened: the parts of the call the
 * row itself leaves out, then what came back.
 *
 * `INPUT_VIEWS` is keyed by every canonical tool name, so a new tool without a
 * decision here is a type error, the same guardrail as the component registry.
 */

import type { KnownToolName, ToolUseBlock } from '$shared/types/unified';
import { resultText } from '../../../tool-result';

export type DetailView =
	| { kind: 'diff'; label: string; oldString: string; newString: string }
	| { kind: 'code'; label: string; code: string; tone?: 'add' | 'neutral' }
	| { kind: 'terminal'; label: string; code: string }
	| { kind: 'markdown'; label: string; text: string };

type Input = Record<string, unknown>;
type InputView = (input: Input) => DetailView | null;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The arguments as they were sent, for calls the row only summarises. */
const json: InputView = (input) => {
	const keys = Object.keys(input ?? {}).filter((key) => input[key] !== undefined && input[key] !== null);
	if (keys.length === 0) return null;
	return { kind: 'code', label: 'Input', code: JSON.stringify(input, null, 2) };
};

/** null: the row already shows the whole call. */
const INPUT_VIEWS: Record<KnownToolName, InputView | null> = {
	Bash: null,
	Read: null,
	Edit: (input) => ({ kind: 'diff', label: 'Changes', oldString: text(input.oldString), newString: text(input.newString) }),
	Write: (input) => ({ kind: 'code', label: 'Content', code: text(input.content), tone: 'add' }),
	Patch: (input) => ({ kind: 'code', label: 'Patch', code: text(input.patch) }),
	NotebookEdit: (input) => (text(input.newSource) ? { kind: 'code', label: 'Cell source', code: text(input.newSource) } : null),
	Glob: null,
	Grep: json,
	List: null,
	WebFetch: (input) => (text(input.prompt) ? { kind: 'markdown', label: 'Prompt', text: text(input.prompt) } : null),
	WebSearch: null,
	TodoWrite: null,
	AskUserQuestion: null,
	EnterPlanMode: null,
	ExitPlanMode: json,
	Agent: (input) => (text(input.prompt) ? { kind: 'markdown', label: 'Prompt', text: text(input.prompt) } : null),
	Workflow: (input) => (text(input.script) ? { kind: 'code', label: 'Script', code: text(input.script) } : json(input)),
	TaskOutput: null,
	TaskStop: null,
	TaskCreate: json,
	TaskGet: null,
	TaskUpdate: json,
	TaskList: null,
	ListMcpResources: null,
	ReadMcpResource: null,
	Config: json,
	EnterWorktree: json,
	ExitWorktree: json,
	Skill: null,
	ToolSearch: null,
	Lsp: json,
	REPL: (input) => (text(input.code) ? { kind: 'code', label: 'Code', code: text(input.code) } : null),
	SendMessage: (input) => (text(input.message) ? { kind: 'markdown', label: 'Message', text: text(input.message) } : null),
	ListAgents: null,
	ReadAgent: null,
	SendInbox: json,
	ContextBoard: json,
	ScheduleWakeup: json,
	Monitor: json,
	PushNotification: json,
	RemoteTrigger: json,
	CronCreate: json,
	CronDelete: null,
	CronList: null
};

/** What comes back is either noise next to the input (a file write's "updated") or shown inline already. */
const NO_OUTPUT = new Set<string>(['Edit', 'Write', 'Patch', 'NotebookEdit', 'TodoWrite', 'AskUserQuestion']);
const TERMINAL_OUTPUT = new Set<string>(['Bash', 'TaskOutput']);
const MARKDOWN_OUTPUT = new Set<string>(['Agent', 'Workflow', 'WebFetch', 'ReadAgent', 'SendMessage']);

function inputView(tool: ToolUseBlock): DetailView | null {
	const input = (tool.input ?? {}) as Input;
	if (tool.name.startsWith('mcp__') || tool.name.startsWith('Unknown:')) return json(input);
	const view = INPUT_VIEWS[tool.name as KnownToolName];
	return view ? view(input) : null;
}

function outputView(tool: ToolUseBlock): DetailView | null {
	if (NO_OUTPUT.has(tool.name)) return null;
	const output = resultText(tool.result).trim();
	if (!output) return null;
	if (TERMINAL_OUTPUT.has(tool.name)) return { kind: 'terminal', label: 'Output', code: output };
	if (MARKDOWN_OUTPUT.has(tool.name)) return { kind: 'markdown', label: 'Result', text: output };
	return { kind: 'code', label: 'Output', code: output };
}

/**
 * The sections to show for a call. `tool` is the call as its renderer sees it,
 * so a failed result is already gone and the failure is shown on its own.
 */
export function detailViews(tool: ToolUseBlock): DetailView[] {
	return [inputView(tool), outputView(tool)].filter((view): view is DetailView => view !== null);
}
