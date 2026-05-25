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

// Classic variants
import AgentToolClassic from './variants/classic/AgentTool.svelte';
import AskUserQuestionToolClassic from './variants/classic/AskUserQuestionTool.svelte';
import BashToolClassic from './variants/classic/BashTool.svelte';
import BashOutputToolClassic from './variants/classic/BashOutputTool.svelte';
import ConfigToolClassic from './variants/classic/ConfigTool.svelte';
import CronCreateToolClassic from './variants/classic/CronCreateTool.svelte';
import CronDeleteToolClassic from './variants/classic/CronDeleteTool.svelte';
import CronListToolClassic from './variants/classic/CronListTool.svelte';
import EditToolClassic from './variants/classic/EditTool.svelte';
import EnterPlanModeToolClassic from './variants/classic/EnterPlanModeTool.svelte';
import EnterWorktreeToolClassic from './variants/classic/EnterWorktreeTool.svelte';
import ExitPlanModeToolClassic from './variants/classic/ExitPlanModeTool.svelte';
import ExitWorktreeToolClassic from './variants/classic/ExitWorktreeTool.svelte';
import GlobToolClassic from './variants/classic/GlobTool.svelte';
import GrepToolClassic from './variants/classic/GrepTool.svelte';
import ListMcpResourcesToolClassic from './variants/classic/ListMcpResourcesTool.svelte';
import ListToolClassic from './variants/classic/ListTool.svelte';
import LspToolClassic from './variants/classic/LspTool.svelte';
import MonitorToolClassic from './variants/classic/MonitorTool.svelte';
import NotebookEditToolClassic from './variants/classic/NotebookEditTool.svelte';
import PatchToolClassic from './variants/classic/PatchTool.svelte';
import PushNotificationToolClassic from './variants/classic/PushNotificationTool.svelte';
import ReadMcpResourceToolClassic from './variants/classic/ReadMcpResourceTool.svelte';
import ReadToolClassic from './variants/classic/ReadTool.svelte';
import RemoteTriggerToolClassic from './variants/classic/RemoteTriggerTool.svelte';
import ScheduleWakeupToolClassic from './variants/classic/ScheduleWakeupTool.svelte';
import SkillToolClassic from './variants/classic/SkillTool.svelte';
import TaskStopToolClassic from './variants/classic/TaskStopTool.svelte';
import TaskCreateToolClassic from './variants/classic/TaskCreateTool.svelte';
import TaskGetToolClassic from './variants/classic/TaskGetTool.svelte';
import TaskUpdateToolClassic from './variants/classic/TaskUpdateTool.svelte';
import TaskListToolClassic from './variants/classic/TaskListTool.svelte';
import TodoWriteToolClassic from './variants/classic/TodoWriteTool.svelte';
import ToolSearchToolClassic from './variants/classic/ToolSearchTool.svelte';
import WebFetchToolClassic from './variants/classic/WebFetchTool.svelte';
import WebSearchToolClassic from './variants/classic/WebSearchTool.svelte';
import WriteToolClassic from './variants/classic/WriteTool.svelte';

// Compact variants
import AgentToolCompact from './variants/compact/AgentTool.svelte';
import AskUserQuestionToolCompact from './variants/compact/AskUserQuestionTool.svelte';
import BashToolCompact from './variants/compact/BashTool.svelte';
import BashOutputToolCompact from './variants/compact/BashOutputTool.svelte';
import ConfigToolCompact from './variants/compact/ConfigTool.svelte';
import CronCreateToolCompact from './variants/compact/CronCreateTool.svelte';
import CronDeleteToolCompact from './variants/compact/CronDeleteTool.svelte';
import CronListToolCompact from './variants/compact/CronListTool.svelte';
import EditToolCompact from './variants/compact/EditTool.svelte';
import EnterPlanModeToolCompact from './variants/compact/EnterPlanModeTool.svelte';
import EnterWorktreeToolCompact from './variants/compact/EnterWorktreeTool.svelte';
import ExitPlanModeToolCompact from './variants/compact/ExitPlanModeTool.svelte';
import ExitWorktreeToolCompact from './variants/compact/ExitWorktreeTool.svelte';
import GlobToolCompact from './variants/compact/GlobTool.svelte';
import GrepToolCompact from './variants/compact/GrepTool.svelte';
import ListMcpResourcesToolCompact from './variants/compact/ListMcpResourcesTool.svelte';
import ListToolCompact from './variants/compact/ListTool.svelte';
import LspToolCompact from './variants/compact/LspTool.svelte';
import MonitorToolCompact from './variants/compact/MonitorTool.svelte';
import NotebookEditToolCompact from './variants/compact/NotebookEditTool.svelte';
import PatchToolCompact from './variants/compact/PatchTool.svelte';
import PushNotificationToolCompact from './variants/compact/PushNotificationTool.svelte';
import ReadMcpResourceToolCompact from './variants/compact/ReadMcpResourceTool.svelte';
import ReadToolCompact from './variants/compact/ReadTool.svelte';
import RemoteTriggerToolCompact from './variants/compact/RemoteTriggerTool.svelte';
import ScheduleWakeupToolCompact from './variants/compact/ScheduleWakeupTool.svelte';
import SkillToolCompact from './variants/compact/SkillTool.svelte';
import TaskStopToolCompact from './variants/compact/TaskStopTool.svelte';
import TaskCreateToolCompact from './variants/compact/TaskCreateTool.svelte';
import TaskGetToolCompact from './variants/compact/TaskGetTool.svelte';
import TaskUpdateToolCompact from './variants/compact/TaskUpdateTool.svelte';
import TaskListToolCompact from './variants/compact/TaskListTool.svelte';
import TodoWriteToolCompact from './variants/compact/TodoWriteTool.svelte';
import ToolSearchToolCompact from './variants/compact/ToolSearchTool.svelte';
import WebFetchToolCompact from './variants/compact/WebFetchTool.svelte';
import WebSearchToolCompact from './variants/compact/WebSearchTool.svelte';
import WriteToolCompact from './variants/compact/WriteTool.svelte';

type ToolComponent = Component<{ toolInput: ToolUseBlock }>;

export const TOOL_COMPONENTS_CLASSIC: Record<KnownToolName, ToolComponent> = {
	// File operations
	Bash: BashToolClassic,
	Read: ReadToolClassic,
	Edit: EditToolClassic,
	Write: WriteToolClassic,
	Patch: PatchToolClassic,
	NotebookEdit: NotebookEditToolClassic,
	// Discovery
	Glob: GlobToolClassic,
	Grep: GrepToolClassic,
	List: ListToolClassic,
	// Web
	WebFetch: WebFetchToolClassic,
	WebSearch: WebSearchToolClassic,
	// Planning & questions
	TodoWrite: TodoWriteToolClassic,
	AskUserQuestion: AskUserQuestionToolClassic,
	EnterPlanMode: EnterPlanModeToolClassic,
	ExitPlanMode: ExitPlanModeToolClassic,
	// Sub-agents & tasks
	Agent: AgentToolClassic,
	TaskOutput: BashOutputToolClassic,
	TaskStop: TaskStopToolClassic,
	TaskCreate: TaskCreateToolClassic,
	TaskGet: TaskGetToolClassic,
	TaskUpdate: TaskUpdateToolClassic,
	TaskList: TaskListToolClassic,
	// MCP
	ListMcpResources: ListMcpResourcesToolClassic,
	ReadMcpResource: ReadMcpResourceToolClassic,
	// Harness / workspace
	Config: ConfigToolClassic,
	EnterWorktree: EnterWorktreeToolClassic,
	ExitWorktree: ExitWorktreeToolClassic,
	Skill: SkillToolClassic,
	ToolSearch: ToolSearchToolClassic,
	Lsp: LspToolClassic,
	// Automation & notifications
	ScheduleWakeup: ScheduleWakeupToolClassic,
	Monitor: MonitorToolClassic,
	PushNotification: PushNotificationToolClassic,
	RemoteTrigger: RemoteTriggerToolClassic,
	CronCreate: CronCreateToolClassic,
	CronDelete: CronDeleteToolClassic,
	CronList: CronListToolClassic,
};

export const TOOL_COMPONENTS_COMPACT: Record<KnownToolName, ToolComponent> = {
	// File operations
	Bash: BashToolCompact,
	Read: ReadToolCompact,
	Edit: EditToolCompact,
	Write: WriteToolCompact,
	Patch: PatchToolCompact,
	NotebookEdit: NotebookEditToolCompact,
	// Discovery
	Glob: GlobToolCompact,
	Grep: GrepToolCompact,
	List: ListToolCompact,
	// Web
	WebFetch: WebFetchToolCompact,
	WebSearch: WebSearchToolCompact,
	// Planning & questions
	TodoWrite: TodoWriteToolCompact,
	AskUserQuestion: AskUserQuestionToolCompact,
	EnterPlanMode: EnterPlanModeToolCompact,
	ExitPlanMode: ExitPlanModeToolCompact,
	// Sub-agents & tasks
	Agent: AgentToolCompact,
	TaskOutput: BashOutputToolCompact,
	TaskStop: TaskStopToolCompact,
	TaskCreate: TaskCreateToolCompact,
	TaskGet: TaskGetToolCompact,
	TaskUpdate: TaskUpdateToolCompact,
	TaskList: TaskListToolCompact,
	// MCP
	ListMcpResources: ListMcpResourcesToolCompact,
	ReadMcpResource: ReadMcpResourceToolCompact,
	// Harness / workspace
	Config: ConfigToolCompact,
	EnterWorktree: EnterWorktreeToolCompact,
	ExitWorktree: ExitWorktreeToolCompact,
	Skill: SkillToolCompact,
	ToolSearch: ToolSearchToolCompact,
	Lsp: LspToolCompact,
	// Automation & notifications
	ScheduleWakeup: ScheduleWakeupToolCompact,
	Monitor: MonitorToolCompact,
	PushNotification: PushNotificationToolCompact,
	RemoteTrigger: RemoteTriggerToolCompact,
	CronCreate: CronCreateToolCompact,
	CronDelete: CronDeleteToolCompact,
	CronList: CronListToolCompact,
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
	// Task tools drive the TaskProgress panel (see TaskProgress.svelte) rather
	// than rendering inline — same treatment as TodoWrite.
	'TaskCreate',
	'TaskUpdate',
	'TaskGet',
	'TaskList',
]);
