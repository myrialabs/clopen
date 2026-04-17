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
	AgentInput,
	TaskOutputInput,
	TaskStopInput,
	NotebookEditInput,
	ListMcpResourcesInput,
	ReadMcpResourceInput,
	ConfigInput,
	EnterWorktreeInput,
	EnterPlanModeInput,
	ExitPlanModeInput,
	ExitPlanModePrompt,
	SkillInput,
	ToolInputMap,
	KnownToolName,
	McpToolName,
	SubAgentToolActivity,
	SubAgentTextActivity,
	SubAgentActivity,
	ToolResult,
	McpToolUseBlock,
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
	EngineOutput,
	StreamEventType,
	StreamStatus,
	StreamNotification,
	PartialMessageData,
	MessageTransportData,
	StreamRequest,
} from './stream';
