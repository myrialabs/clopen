/**
 * Unified Message Type System
 *
 * Engine-agnostic, strongly-typed message types for the Clopen chat system.
 *
 *   Engine SDK (Claude/OpenCode/Copilot)
 *          ↓ adapter converts
 *   EngineOutput (stream.ts)
 *          ↓ stream-manager routes
 *   UnifiedMessage (message.ts)  →  DB  →  Frontend
 */

// ── Common ───────────────────────────────────────────────────
export type {
	TokenUsage,
	StopReason,
	EngineType,
} from './common';

// ── Engine ──────────────────────────────────────────────────
export type {
	EngineModel,
	EngineInfo,
	QwenProviderPresetId,
	QwenProviderPreset,
	PiAuthMode,
	PiCredentialField,
	PiProviderPreset,
} from './engine';

// ── Tools ────────────────────────────────────────────────────
export type {
	BashInput,
	ReadInput,
	EditInput,
	WriteInput,
	GlobInput,
	GrepInput,
	WebFetchInput,
	WebSearchInput,
	AskUserQuestionInput,
	AskUserQuestion,
	AskUserQuestionOption,
	TodoWriteInput,
	TodoItem,
	TaskStatus,
	TaskCreateInput,
	TaskGetInput,
	TaskUpdateInput,
	TaskListInput,
	AgentInput,
	TaskOutputInput,
	TaskStopInput,
	NotebookEditInput,
	ListMcpResourcesInput,
	ReadMcpResourceInput,
	ConfigInput,
	EnterWorktreeInput,
	ExitWorktreeInput,
	EnterPlanModeInput,
	ExitPlanModeInput,
	ExitPlanModePrompt,
	SkillInput,
	ToolSearchInput,
	ScheduleWakeupInput,
	MonitorInput,
	PushNotificationInput,
	RemoteTriggerInput,
	CronCreateInput,
	CronDeleteInput,
	CronListInput,
	PatchInput,
	ListInput,
	LspInput,
	ToolInputMap,
	KnownToolName,
	McpToolName,
	UnknownToolName,
} from './tool';

export {
	CANONICAL_TOOL_NAMES,
	toCanonicalToolName,
} from './tool';

export type {
	SubAgentToolActivity,
	SubAgentTextActivity,
	SubAgentActivity,
	ToolResult,
	McpToolUseBlock,
	UnknownToolUseBlock,
	ToolUseBlock,
} from './tool';

// ── Messages ─────────────────────────────────────────────────
export type {
	MessageBase,
	MessageEngine,
	MessageModel,
	MessageParent,
	MessageSender,
	MessageAccount,
	TextBlock,
	ImageBlock,
	DocumentBlock,
	UserContentBlock,
	AssistantContentBlock,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	CompactBoundaryMessage,
	UnifiedMessage,
} from './message';

// ── Display ──────────────────────────────────────────────────
export type {
	ToolGroup,
	BackgroundBashData,
} from './display';

// ── Stream & Engine ──────────────────────────────────────────
export type {
	TextDeltaEvent,
	StreamLifecycleEvent,
	StreamEvent,
	SuccessResultEvent,
	ErrorResultEvent,
	ResultEvent,
	SystemInitEvent,
	McpServerStatus,
	RateLimitEvent,
	RateLimitType,
	NotificationEvent,
	EngineOutput,
	StreamEventType,
	StreamStatus,
	StreamNotification,
	PartialMessageData,
	MessageTransportData,
	StreamRequest,
} from './stream';
