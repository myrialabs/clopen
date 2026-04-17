/**
 * Tool component registry — single source of truth for chat tool rendering.
 *
 * Every canonical tool name (`KnownToolName` in `$shared/types/unified`) must
 * have an entry here. The `Record<KnownToolName, …>` type makes the mapping
 * exhaustive: adding a tool to `ToolInputMap` without registering a component
 * is a type error at build time, which is exactly the guardrail this system
 * was missing before.
 *
 * `Tools.svelte` resolves the component for canonical names from this map.
 * MCP tools (`mcp__*`) and Unknown tools (`Unknown:*`) are routed by prefix
 * and rendered by `CustomMcpTool` / `UnknownTool` respectively — they are not
 * canonical and therefore not in this map.
 */

import type { Component } from 'svelte';
import type { KnownToolName, ToolUseBlock } from '$shared/types/unified';

import AgentTool from './AgentTool.svelte';
import AskUserQuestionTool from './AskUserQuestionTool.svelte';
import BashTool from './BashTool.svelte';
import BashOutputTool from './BashOutputTool.svelte';
import ConfigTool from './ConfigTool.svelte';
import CronCreateTool from './CronCreateTool.svelte';
import CronDeleteTool from './CronDeleteTool.svelte';
import CronListTool from './CronListTool.svelte';
import EditTool from './EditTool.svelte';
import EnterPlanModeTool from './EnterPlanModeTool.svelte';
import EnterWorktreeTool from './EnterWorktreeTool.svelte';
import ExitPlanModeTool from './ExitPlanModeTool.svelte';
import ExitWorktreeTool from './ExitWorktreeTool.svelte';
import GlobTool from './GlobTool.svelte';
import GrepTool from './GrepTool.svelte';
import ListMcpResourcesTool from './ListMcpResourcesTool.svelte';
import ListTool from './ListTool.svelte';
import LspTool from './LspTool.svelte';
import MonitorTool from './MonitorTool.svelte';
import NotebookEditTool from './NotebookEditTool.svelte';
import PatchTool from './PatchTool.svelte';
import PushNotificationTool from './PushNotificationTool.svelte';
import ReadMcpResourceTool from './ReadMcpResourceTool.svelte';
import ReadTool from './ReadTool.svelte';
import RemoteTriggerTool from './RemoteTriggerTool.svelte';
import ScheduleWakeupTool from './ScheduleWakeupTool.svelte';
import SkillTool from './SkillTool.svelte';
import TaskStopTool from './TaskStopTool.svelte';
import TodoWriteTool from './TodoWriteTool.svelte';
import ToolSearchTool from './ToolSearchTool.svelte';
import WebFetchTool from './WebFetchTool.svelte';
import WebSearchTool from './WebSearchTool.svelte';
import WriteTool from './WriteTool.svelte';

type ToolComponent = Component<{ toolInput: ToolUseBlock }>;

export const TOOL_COMPONENTS: Record<KnownToolName, ToolComponent> = {
	// File operations
	Bash: BashTool,
	Read: ReadTool,
	Edit: EditTool,
	Write: WriteTool,
	Patch: PatchTool,
	NotebookEdit: NotebookEditTool,
	// Discovery
	Glob: GlobTool,
	Grep: GrepTool,
	List: ListTool,
	// Web
	WebFetch: WebFetchTool,
	WebSearch: WebSearchTool,
	// Planning & questions
	TodoWrite: TodoWriteTool,
	AskUserQuestion: AskUserQuestionTool,
	EnterPlanMode: EnterPlanModeTool,
	ExitPlanMode: ExitPlanModeTool,
	// Sub-agents & tasks
	Agent: AgentTool,
	TaskOutput: BashOutputTool,
	TaskStop: TaskStopTool,
	// MCP
	ListMcpResources: ListMcpResourcesTool,
	ReadMcpResource: ReadMcpResourceTool,
	// Harness / workspace
	Config: ConfigTool,
	EnterWorktree: EnterWorktreeTool,
	ExitWorktree: ExitWorktreeTool,
	Skill: SkillTool,
	ToolSearch: ToolSearchTool,
	Lsp: LspTool,
	// Automation & notifications
	ScheduleWakeup: ScheduleWakeupTool,
	Monitor: MonitorTool,
	PushNotification: PushNotificationTool,
	RemoteTrigger: RemoteTriggerTool,
	CronCreate: CronCreateTool,
	CronDelete: CronDeleteTool,
	CronList: CronListTool,
};

/**
 * Tools deliberately hidden from the chat stream. They still flow through
 * the message pipeline (results are still stitched) but the UI filters them
 * out — other widgets render them (e.g. TaskProgress for TodoWrite).
 */
export const HIDDEN_TOOLS = new Set<KnownToolName>([
	'TodoWrite',
	'TaskOutput',
	'ToolSearch',
]);
