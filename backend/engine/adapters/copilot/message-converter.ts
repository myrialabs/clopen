/**
 * Copilot SDK → Unified Type Converters
 *
 * Translates Copilot SessionEvent objects into EngineOutput (unified types)
 * so the stream-manager and frontend can stay engine-agnostic.
 *
 * Streaming model:
 *   session.start                 → SystemInitEvent
 *   assistant.turn_start          → StreamLifecycleEvent { event:'start' }
 *   assistant.reasoning_delta     → TextDeltaEvent { reasoning:true } (and reasoning stream lifecycle)
 *   assistant.reasoning           → ReasoningMessage (final reasoning text)
 *   assistant.message_delta       → TextDeltaEvent { reasoning:false }
 *   assistant.message             → AssistantMessage (text + tool_use blocks)
 *   tool.execution_start          → AssistantMessage { tool_use only }
 *   tool.execution_complete       → UserMessage     { tool_result only }
 *   assistant.usage               → captured for ResultEvent
 *   assistant.turn_end            → StreamLifecycleEvent { event:'stop' }
 *   session.idle                  → SuccessResultEvent (or aborted no-op)
 *   session.error                 → throw buildSessionError(data)
 */

import type { MessageEngine } from '$shared/types/unified';
import type {
	EngineOutput,
	UserMessage,
	AssistantMessage as UnifiedAssistantMessage,
	ReasoningMessage,
	AssistantContentBlock,
	UserContentBlock,
	ToolUseBlock,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	SystemInitEvent,
	TokenUsage,
	BashInput,
	ReadInput,
	EditInput,
	WriteInput,
	GlobInput,
	GrepInput,
	WebFetchInput,
	WebSearchInput,
	AskUserQuestionInput,
	TodoWriteInput,
	ToolSearchInput,
	ListInput,
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';
import type { SessionEvent } from '@github/copilot-sdk';

// Derive data payload types from the SessionEvent discriminated union so we
// don't depend on internal type re-exports that aren't part of the SDK's
// public surface.
type StartData = Extract<SessionEvent, { type: 'session.start' }>['data'];
type AssistantReasoningData = Extract<SessionEvent, { type: 'assistant.reasoning' }>['data'];
type AssistantReasoningDeltaData = Extract<SessionEvent, { type: 'assistant.reasoning_delta' }>['data'];
type AssistantMessageData = Extract<SessionEvent, { type: 'assistant.message' }>['data'];
type AssistantMessageDeltaData = Extract<SessionEvent, { type: 'assistant.message_delta' }>['data'];
type AssistantMessageToolRequest = NonNullable<AssistantMessageData['toolRequests']>[number];
type AssistantTurnEndData = Extract<SessionEvent, { type: 'assistant.turn_end' }>['data'];
type AssistantUsageData = Extract<SessionEvent, { type: 'assistant.usage' }>['data'];
type ToolExecutionStartData = Extract<SessionEvent, { type: 'tool.execution_start' }>['data'];
type ToolExecutionCompleteData = Extract<SessionEvent, { type: 'tool.execution_complete' }>['data'];

// ============================================================================
// Engine Identity
// ============================================================================

/** Build a MessageEngine descriptor for Copilot messages. */
export function buildEngine(modelId: string): MessageEngine {
	return {
		type: 'copilot',
		provider: 'github',
		model: { id: modelId, name: '' },
		account: { id: 0, name: '' },
	};
}

// ============================================================================
// Tool Name Mapping
// ============================================================================

type RawToolArgs = Record<string, unknown>;

/**
 * Copilot CLI built-in tool names → canonical UI tool names.
 *
 * The Copilot CLI emits tool names in snake_case. The `str_replace_editor`
 * umbrella tool is split server-side into discriminated subcommands
 * (`view`, `create`, `str_replace`, `edit`, `insert`) which arrive as
 * separate `toolName` values in `tool.execution_*` events.
 */
const COPILOT_TOOL_NAME_MAP: Record<string, string> = {
	// Shell / commands
	'bash': 'Bash',
	'shell': 'Bash',
	'run_in_terminal': 'Bash',

	// File read (str_replace_editor view subcommand)
	'view': 'Read',
	'read': 'Read',
	'read_file': 'Read',

	// File create (str_replace_editor create subcommand)
	'create': 'Write',
	'write': 'Write',
	'write_file': 'Write',
	'create_file': 'Write',

	// File edit (str_replace_editor edit/str_replace/insert subcommands)
	'str_replace': 'Edit',
	'str_replace_editor': 'Edit',
	'edit': 'Edit',
	'edit_file': 'Edit',
	'insert': 'Edit',

	// Search / discovery
	'grep': 'Grep',
	'grep_search': 'Grep',
	'glob': 'Glob',
	'glob_search': 'Glob',
	'list': 'List',
	'list_dir': 'List',
	'ls': 'List',

	// Task / planning
	'update_todo': 'TodoWrite',
	'todo_write': 'TodoWrite',
	'todowrite': 'TodoWrite',

	// User interaction
	'ask_user': 'AskUserQuestion',
	'question': 'AskUserQuestion',

	// Web
	'web_search': 'WebSearch',
	'websearch': 'WebSearch',
	'fetch': 'WebFetch',
	'fetch_url': 'WebFetch',
	'web_fetch': 'WebFetch',
	'webfetch': 'WebFetch',

	// Tool discovery
	'tool_search': 'ToolSearch',
	'tool_search_tool_regex': 'ToolSearch',
};

/**
 * Copilot CLI internal tools used for model↔harness coordination (intent
 * reporting, task completion markers, work proposals, doc fetches). They
 * carry no user-actionable information, so we filter them out at the adapter
 * boundary instead of rendering them as `Unknown:*` blocks in the chat UI.
 */
const IGNORED_COPILOT_TOOLS = new Set<string>([
	'report_intent',
	'task_complete',
	'propose_work',
	'fetch_copilot_cli_documentation',
]);

/** True if a tool name should be silently dropped from the stream. */
export function isIgnoredCopilotTool(rawName: string, mcpServerName?: string): boolean {
	if (mcpServerName) return false;
	return IGNORED_COPILOT_TOOLS.has(rawName.toLowerCase());
}

/** Map a raw Copilot tool name (with optional MCP server) to a canonical UI name. */
function mapCopilotToolName(rawName: string, mcpServerName?: string): string {
	if (mcpServerName) return `mcp__${mcpServerName}__${rawName}`;
	const lower = rawName.toLowerCase();
	const mapped = COPILOT_TOOL_NAME_MAP[lower] ?? COPILOT_TOOL_NAME_MAP[rawName] ?? rawName;
	return toCanonicalToolName(mapped);
}

// ============================================================================
// Tool Input Normalizer Helpers
// ============================================================================

function str(raw: RawToolArgs, ...keys: string[]): string {
	for (const k of keys) {
		const v = raw[k];
		if (v != null) return String(v);
	}
	return '';
}

function optStr(raw: RawToolArgs, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = raw[k];
		if (v != null) return String(v);
	}
	return undefined;
}

function optNum(raw: RawToolArgs, ...keys: string[]): number | undefined {
	for (const k of keys) {
		const v = raw[k];
		if (v != null) return Number(v);
	}
	return undefined;
}

function optBool(raw: RawToolArgs, ...keys: string[]): boolean | undefined {
	for (const k of keys) {
		const v = raw[k];
		if (v != null) return Boolean(v);
	}
	return undefined;
}

// ============================================================================
// Per-Tool Input Normalizers
// ============================================================================

function normalizeBashInput(raw: RawToolArgs): BashInput {
	const result: BashInput = { command: str(raw, 'command', 'cmd', 'shell') };
	const description = optStr(raw, 'description', 'desc');
	if (description != null) result.description = description;
	const timeout = optNum(raw, 'timeout', 'timeoutMs', 'timeout_ms');
	if (timeout != null) result.timeout = timeout;
	const runInBackground = optBool(raw, 'run_in_background', 'runInBackground', 'background');
	if (runInBackground != null) result.runInBackground = runInBackground;
	return result;
}

/**
 * `view` subcommand of `str_replace_editor` accepts `view_range: [start, end]`
 * (1-indexed, inclusive). Translate it into Read's `offset` + `limit`.
 */
function normalizeReadInput(raw: RawToolArgs): ReadInput {
	const result: ReadInput = {
		filePath: str(raw, 'path', 'file_path', 'filePath'),
	};
	const offset = optNum(raw, 'offset');
	if (offset != null) result.offset = offset;
	const limit = optNum(raw, 'limit');
	if (limit != null) result.limit = limit;

	const range = raw.view_range ?? raw.viewRange;
	if (Array.isArray(range) && range.length >= 1) {
		const start = Number(range[0]);
		const end = range.length >= 2 ? Number(range[1]) : undefined;
		if (Number.isFinite(start)) {
			if (result.offset == null) result.offset = start;
			if (result.limit == null && end != null && Number.isFinite(end)) {
				result.limit = Math.max(end - start + 1, 1);
			}
		}
	}
	return result;
}

function normalizeWriteInput(raw: RawToolArgs): WriteInput {
	return {
		filePath: str(raw, 'path', 'file_path', 'filePath'),
		content: str(raw, 'file_text', 'content', 'text'),
	};
}

/**
 * Edit covers three Copilot subcommands: `str_replace`, `edit`, and `insert`.
 * - str_replace/edit: `{ path, old_str, new_str }`
 * - insert:           `{ path, insert_line, new_str }` (oldString left empty)
 */
function normalizeEditInput(raw: RawToolArgs): EditInput {
	const result: EditInput = {
		filePath: str(raw, 'path', 'file_path', 'filePath'),
		oldString: str(raw, 'old_str', 'old_string', 'oldString'),
		newString: str(raw, 'new_str', 'new_string', 'newString'),
	};
	const replaceAll = optBool(raw, 'replace_all', 'replaceAll');
	if (replaceAll != null) result.replaceAll = replaceAll;
	return result;
}

function normalizeGrepInput(raw: RawToolArgs): GrepInput {
	const result: GrepInput = { pattern: str(raw, 'pattern', 'query') };
	const path = optStr(raw, 'path', 'directory', 'dir');
	if (path != null) result.path = path;
	const glob = optStr(raw, 'glob', 'include', 'file_pattern');
	if (glob != null) result.glob = glob;
	const outputMode = optStr(raw, 'output_mode', 'outputMode') as GrepInput['outputMode'];
	if (outputMode != null) result.outputMode = outputMode;
	const type = optStr(raw, 'type', 'file_type');
	if (type != null) result.type = type;
	const headLimit = optNum(raw, 'head_limit', 'headLimit', 'max_results');
	if (headLimit != null) result.headLimit = headLimit;
	const offset = optNum(raw, 'offset');
	if (offset != null) result.offset = offset;
	const multiline = optBool(raw, 'multiline');
	if (multiline != null) result.multiline = multiline;
	const caseInsensitive = optBool(raw, 'case_insensitive', 'caseInsensitive', 'ignore_case', '-i');
	if (caseInsensitive != null) result.caseInsensitive = caseInsensitive;
	const beforeContext = optNum(raw, 'before_context', 'beforeContext', '-B');
	if (beforeContext != null) result.beforeContext = beforeContext;
	const afterContext = optNum(raw, 'after_context', 'afterContext', '-A');
	if (afterContext != null) result.afterContext = afterContext;
	const context = optNum(raw, 'context', '-C');
	if (context != null) result.context = context;
	const lineNumbers = optBool(raw, 'line_numbers', 'lineNumbers', '-n');
	if (lineNumbers != null) result.lineNumbers = lineNumbers;
	return result;
}

function normalizeGlobInput(raw: RawToolArgs): GlobInput {
	const result: GlobInput = { pattern: str(raw, 'pattern', 'glob', 'query') };
	const path = optStr(raw, 'path', 'directory', 'dir');
	if (path != null) result.path = path;
	return result;
}

function normalizeListInput(raw: RawToolArgs): ListInput {
	const result: ListInput = {};
	const path = optStr(raw, 'path', 'directory', 'dir');
	if (path != null) result.path = path;
	const ignore = raw.ignore;
	if (Array.isArray(ignore) && ignore.length) result.ignore = ignore.map(String);
	return result;
}

function normalizeWebSearchInput(raw: RawToolArgs): WebSearchInput {
	const result: WebSearchInput = { query: str(raw, 'query', 'q', 'search') };
	const allowed = raw.allowed_domains ?? raw.allowedDomains;
	if (Array.isArray(allowed) && allowed.length) result.allowedDomains = allowed.map(String);
	const blocked = raw.blocked_domains ?? raw.blockedDomains;
	if (Array.isArray(blocked) && blocked.length) result.blockedDomains = blocked.map(String);
	return result;
}

function normalizeWebFetchInput(raw: RawToolArgs): WebFetchInput {
	return {
		url: str(raw, 'url', 'href'),
		prompt: str(raw, 'prompt', 'instruction', 'query', 'format'),
	};
}

function normalizeAskUserQuestionInput(raw: RawToolArgs): AskUserQuestionInput {
	const questions = raw.questions;
	if (Array.isArray(questions)) {
		return { questions: questions as AskUserQuestionInput['questions'] };
	}
	// Copilot's `ask_user` typically passes a single `question` string + optional `choices` array.
	const question = str(raw, 'question', 'prompt');
	if (!question) return { questions: [] };
	const choices = raw.choices ?? raw.options;
	const options = Array.isArray(choices)
		? choices.map(c => ({
			label: String(typeof c === 'object' && c && 'label' in c ? (c as Record<string, unknown>).label : c),
			description: '',
		}))
		: [];
	return {
		questions: [{
			question,
			header: '',
			options,
			multiSelect: false,
		}],
	};
}

function normalizeTodoWriteInput(raw: RawToolArgs): TodoWriteInput {
	const todos = raw.todos ?? raw.items ?? raw.list;
	return { todos: Array.isArray(todos) ? (todos as TodoWriteInput['todos']) : [] };
}

function normalizeToolSearchInput(raw: RawToolArgs): ToolSearchInput {
	const result: ToolSearchInput = { query: str(raw, 'query', 'pattern', 'regex') };
	const maxResults = optNum(raw, 'max_results', 'maxResults', 'limit');
	if (maxResults != null) result.maxResults = maxResults;
	return result;
}

/**
 * Normalize raw Copilot tool arguments → canonical input shape. Unknown/MCP
 * tools fall through with their args unchanged.
 */
function normalizeCopilotToolInput(canonical: string, raw: RawToolArgs): Record<string, unknown> {
	if (canonical.startsWith('mcp__') || canonical.startsWith('Unknown:')) return raw;
	switch (canonical) {
		case 'Bash': return normalizeBashInput(raw) as unknown as Record<string, unknown>;
		case 'Read': return normalizeReadInput(raw) as unknown as Record<string, unknown>;
		case 'Write': return normalizeWriteInput(raw) as unknown as Record<string, unknown>;
		case 'Edit': return normalizeEditInput(raw) as unknown as Record<string, unknown>;
		case 'Grep': return normalizeGrepInput(raw) as unknown as Record<string, unknown>;
		case 'Glob': return normalizeGlobInput(raw) as unknown as Record<string, unknown>;
		case 'List': return normalizeListInput(raw) as unknown as Record<string, unknown>;
		case 'WebSearch': return normalizeWebSearchInput(raw) as unknown as Record<string, unknown>;
		case 'WebFetch': return normalizeWebFetchInput(raw) as unknown as Record<string, unknown>;
		case 'AskUserQuestion': return normalizeAskUserQuestionInput(raw) as unknown as Record<string, unknown>;
		case 'TodoWrite': return normalizeTodoWriteInput(raw) as unknown as Record<string, unknown>;
		case 'ToolSearch': return normalizeToolSearchInput(raw) as unknown as Record<string, unknown>;
		default: return raw;
	}
}

// ============================================================================
// Stream State (per-stream, isolated across concurrent sessions)
// ============================================================================

export interface StreamConverterState {
	sessionId: string;
	modelId: string;
	/** Reasoning text accumulated from reasoning_delta events, keyed by reasoningId. */
	reasoningBuffers: Map<string, string>;
	/** ToolCallId → tool name (canonicalised) so tool_result can reference it. */
	toolNames: Map<string, string>;
	/** Whether the assistant text stream is currently open (for lifecycle pairing). */
	textStreamActive: boolean;
	/** Whether the assistant reasoning stream is currently open. */
	reasoningStreamActive: boolean;
	/** Last seen usage payload — held until session.idle to build the ResultEvent. */
	lastUsage: AssistantUsageData | null;
	/** Most recent assistant.message ID (used for stable parenting if needed). */
	lastAssistantMessageId: string | null;
	/**
	 * Assistant messages awaiting flush. We buffer because `assistant.usage`
	 * arrives AFTER `assistant.message` for the same turn iteration — we want
	 * to attach usage to the originating message before emitting it downstream.
	 */
	pendingMessages: UnifiedAssistantMessage[];
	/**
	 * Tool call IDs whose tool_use was filtered out (Copilot harness tools).
	 * `tool.execution_complete` for these IDs must also be dropped so the UI
	 * never receives an orphan tool_result without its tool_use.
	 */
	ignoredToolCallIds: Set<string>;
}

export function createStreamConverterState(sessionId: string, modelId: string): StreamConverterState {
	return {
		sessionId,
		modelId,
		reasoningBuffers: new Map(),
		toolNames: new Map(),
		textStreamActive: false,
		reasoningStreamActive: false,
		lastUsage: null,
		lastAssistantMessageId: null,
		pendingMessages: [],
		ignoredToolCallIds: new Set(),
	};
}

/**
 * Drain `pendingMessages` and return them as EngineOutput. Call before any
 * downstream-visible event (tool execution, turn end, session idle) so that
 * messages are emitted in source order even if usage attaches late.
 *
 * Fallback: if a message is being emitted with no usage attached (i.e.
 * `assistant.usage` for its LLM call hasn't arrived yet), backfill from the
 * most recent known usage. This keeps the chat header's context-window
 * indicator non-zero in turns where the SDK emits usage AFTER the assistant
 * message has already been forced out (e.g. by a downstream tool event).
 */
export function flushPending(state: StreamConverterState): EngineOutput[] {
	if (state.pendingMessages.length === 0) return [];
	const fallback = state.lastUsage ? mapUsage(state.lastUsage) : null;
	if (fallback) {
		for (const msg of state.pendingMessages) {
			if (msg.usage == null) msg.usage = fallback;
		}
	}
	const out: EngineOutput[] = state.pendingMessages.slice();
	state.pendingMessages = [];
	return out;
}

// ============================================================================
// System / Lifecycle Converters
// ============================================================================

export function convertSessionStart(data: StartData, modelId: string): SystemInitEvent {
	return {
		type: 'system_init',
		sessionId: data.sessionId,
		model: data.selectedModel || modelId || '',
		engine: 'copilot',
		tools: [],
		mcpServers: [],
	};
}

export function convertTurnStart(state: StreamConverterState): StreamLifecycleEvent {
	state.textStreamActive = true;
	return {
		type: 'stream_event',
		event: 'start',
		sessionId: state.sessionId,
		reasoning: false,
	};
}

export function convertTurnEnd(_data: AssistantTurnEndData, state: StreamConverterState): EngineOutput[] {
	const events: EngineOutput[] = flushPending(state);
	if (state.reasoningStreamActive) {
		events.push({ type: 'stream_event', event: 'stop', sessionId: state.sessionId, reasoning: true });
		state.reasoningStreamActive = false;
	}
	if (state.textStreamActive) {
		events.push({ type: 'stream_event', event: 'stop', sessionId: state.sessionId, reasoning: false });
		state.textStreamActive = false;
	}
	return events;
}

// ============================================================================
// Reasoning Converters
// ============================================================================

export function convertReasoningDelta(data: AssistantReasoningDeltaData, state: StreamConverterState): EngineOutput[] {
	const out: EngineOutput[] = [];

	if (!state.reasoningStreamActive) {
		// Pause text stream while reasoning streams.
		if (state.textStreamActive) {
			out.push({ type: 'stream_event', event: 'stop', sessionId: state.sessionId, reasoning: false } as StreamLifecycleEvent);
			state.textStreamActive = false;
		}
		out.push({ type: 'stream_event', event: 'start', sessionId: state.sessionId, reasoning: true } as StreamLifecycleEvent);
		state.reasoningStreamActive = true;
	}

	const prev = state.reasoningBuffers.get(data.reasoningId) ?? '';
	state.reasoningBuffers.set(data.reasoningId, prev + (data.deltaContent ?? ''));

	const delta: TextDeltaEvent = {
		type: 'stream_event',
		event: 'delta',
		sessionId: state.sessionId,
		text: data.deltaContent ?? '',
		reasoning: true,
	};
	out.push(delta);
	return out;
}

export function convertReasoning(data: AssistantReasoningData, state: StreamConverterState): EngineOutput[] {
	const out: EngineOutput[] = [];
	const text = (data.content ?? state.reasoningBuffers.get(data.reasoningId) ?? '').trim();
	state.reasoningBuffers.delete(data.reasoningId);

	if (state.reasoningStreamActive) {
		out.push({ type: 'stream_event', event: 'stop', sessionId: state.sessionId, reasoning: true } as StreamLifecycleEvent);
		state.reasoningStreamActive = false;
	}

	if (!text) return out;

	const reasoning: ReasoningMessage = {
		type: 'reasoning',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		text,
	};
	out.push(reasoning);
	return out;
}

// ============================================================================
// Assistant Message Converters
// ============================================================================

export function convertMessageDelta(data: AssistantMessageDeltaData, state: StreamConverterState): EngineOutput[] {
	const out: EngineOutput[] = [];
	if (state.reasoningStreamActive) {
		out.push({ type: 'stream_event', event: 'stop', sessionId: state.sessionId, reasoning: true } as StreamLifecycleEvent);
		state.reasoningStreamActive = false;
	}
	if (!state.textStreamActive) {
		out.push({ type: 'stream_event', event: 'start', sessionId: state.sessionId, reasoning: false } as StreamLifecycleEvent);
		state.textStreamActive = true;
	}
	const delta: TextDeltaEvent = {
		type: 'stream_event',
		event: 'delta',
		sessionId: state.sessionId,
		text: data.deltaContent ?? '',
		reasoning: false,
	};
	out.push(delta);
	return out;
}

/**
 * Convert a final assistant.message event into one or more assistant messages,
 * one per logical block (text + each tool_use), matching the convention used
 * by the Claude and OpenCode adapters where every assistant message in the
 * chat surface holds AT MOST one tool_use block.
 *
 * Internal Copilot harness tools (see IGNORED_COPILOT_TOOLS) are dropped here
 * so they never reach the UI as `Unknown:*` blocks.
 *
 * Returns previously-buffered messages and buffers the new ones — the actual
 * emission happens lazily so `assistant.usage` (which arrives next in the
 * stream) can attach to the most recent message before it leaves the adapter.
 */
export function convertAssistantMessage(data: AssistantMessageData, state: StreamConverterState): EngineOutput[] {
	state.lastAssistantMessageId = data.messageId;

	const flushed = flushPending(state);

	const visibleToolRequests: AssistantMessageToolRequest[] = [];
	for (const req of data.toolRequests ?? []) {
		const canonical = mapCopilotToolName(req.name, req.mcpServerName);
		state.toolNames.set(req.toolCallId, canonical);
		if (isIgnoredCopilotTool(req.name, req.mcpServerName)) {
			state.ignoredToolCallIds.add(req.toolCallId);
		} else {
			visibleToolRequests.push(req);
		}
	}

	const blocks: AssistantContentBlock[] = [];
	if (data.content && data.content.length > 0) {
		blocks.push({ type: 'text', text: data.content });
	}
	for (const req of visibleToolRequests) {
		blocks.push(buildToolUseBlock(req, state));
	}

	if (blocks.length === 0) {
		return flushed;
	}

	const baseId = data.messageId || crypto.randomUUID();
	const messages: UnifiedAssistantMessage[] = blocks.map((block, idx) => ({
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId: blocks.length === 1 ? baseId : `${baseId}:${idx}`,
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		content: [block],
		stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
		usage: null,
	}));

	state.pendingMessages.push(...messages);
	return flushed;
}

function buildToolUseBlock(req: AssistantMessageToolRequest, _state: StreamConverterState): ToolUseBlock {
	const canonical = mapCopilotToolName(req.name, req.mcpServerName);
	const input = normalizeCopilotToolInput(canonical, (req.arguments ?? {}) as RawToolArgs);
	return {
		type: 'tool_use',
		id: req.toolCallId,
		name: canonical,
		input,
		result: null,
		subActivities: [],
		skillPrompt: null,
		interrupted: false,
	} as ToolUseBlock;
}

// ============================================================================
// Tool Execution Converters
// ============================================================================

/**
 * tool.execution_start arrives WHEN the assistant begins executing a tool. The
 * Copilot SDK already emitted the corresponding tool_use block in the prior
 * assistant.message — so we don't yield anything new here. We just remember
 * the tool name so a later tool_result can carry the canonical name.
 */
export function convertToolStart(data: ToolExecutionStartData, state: StreamConverterState): EngineOutput[] {
	const canonical = mapCopilotToolName(data.toolName, data.mcpServerName);
	state.toolNames.set(data.toolCallId, canonical);
	if (isIgnoredCopilotTool(data.toolName, data.mcpServerName)) {
		state.ignoredToolCallIds.add(data.toolCallId);
	}
	return [];
}

/**
 * tool.execution_complete carries the LLM-facing result content. We emit it as
 * a synthetic UserMessage with a single tool_result block, mirroring how Claude's
 * SDK delivers the same information back to the loop.
 *
 * Results for ignored Copilot harness tools (report_intent, task_complete, …)
 * are dropped so the UI never sees an orphan tool_result without its tool_use.
 *
 * IMPORTANT: `parent.toolUseId` MUST be left null. The frontend grouper
 * (frontend/utils/chat/message-grouper.ts) treats any user message whose
 * parent.toolUseId is non-null as a sub-agent message — i.e. one emitted from
 * inside an Agent (Task) tool execution — and either redirects it into the
 * sub-agent activity bucket or silently drops it. The toolCallId belongs on
 * the inner `tool_result` block, not on the message-level parent pointer.
 * Setting it on `parent.toolUseId` was a bug that caused tool_results to
 * never reach the UI, leaving `tool_use.result` null at render time.
 */
export function convertToolComplete(data: ToolExecutionCompleteData, state: StreamConverterState): EngineOutput[] {
	if (state.ignoredToolCallIds.has(data.toolCallId)) {
		state.ignoredToolCallIds.delete(data.toolCallId);
		state.toolNames.delete(data.toolCallId);
		return [];
	}

	const resultText = extractToolResultContent(data);

	const userBlock: UserContentBlock = {
		type: 'tool_result',
		toolUseId: data.toolCallId,
		content: resultText,
		isError: !data.success || !!data.error,
	};

	const message: UserMessage = {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		sender: { id: '', name: '' },
		content: [userBlock],
		synthetic: true,
	};
	return [message];
}

/**
 * Extract the human-readable content for a tool_result from a Copilot
 * `tool.execution_complete` payload. Prefers `detailedContent` (the diff /
 * full output the model receives), then `content` (short summary), then any
 * structured `contents` blocks, and finally falls back to the error message
 * for failed tool calls.
 */
function extractToolResultContent(data: ToolExecutionCompleteData): string {
	const result = data.result as
		| { detailedContent?: string; content?: string; contents?: unknown }
		| undefined;

	if (typeof result?.detailedContent === 'string' && result.detailedContent.length > 0) {
		return result.detailedContent;
	}
	if (typeof result?.content === 'string' && result.content.length > 0) {
		return result.content;
	}

	if (Array.isArray(result?.contents)) {
		const parts: string[] = [];
		for (const item of result.contents) {
			if (typeof item === 'string') {
				parts.push(item);
			} else if (item && typeof item === 'object') {
				const obj = item as Record<string, unknown>;
				if (typeof obj.text === 'string') parts.push(obj.text);
				else if (typeof obj.content === 'string') parts.push(obj.content);
			}
		}
		const joined = parts.join('\n').trim();
		if (joined) return joined;
	}

	if (data.error?.message) return `Error: ${data.error.message}`;
	if (!data.success) return 'Tool execution failed';
	return '';
}

// ============================================================================
// Usage / Idle Converters
// ============================================================================

/**
 * `assistant.usage` arrives once per LLM call, AFTER the corresponding
 * `assistant.message` (and any tool_use blocks split out of it) but BEFORE
 * tool execution events. We attach the usage to the most recent pending
 * message so the persisted row carries token counts, then flush.
 *
 * The aggregate usage is also retained on `state.lastUsage` for the final
 * `result` event built at session.idle.
 */
export function captureUsage(data: AssistantUsageData, state: StreamConverterState): EngineOutput[] {
	state.lastUsage = data;

	const pending = state.pendingMessages;
	if (pending.length > 0) {
		const target = pending[pending.length - 1]!;
		target.usage = mapUsage(data);
	}
	return flushPending(state);
}

export function buildResultEvent(state: StreamConverterState, aborted: boolean): SuccessResultEvent {
	const usage = mapUsage(state.lastUsage);
	return {
		type: 'result',
		subtype: 'success',
		sessionId: state.sessionId,
		numTurns: 0,
		totalCostUsd: state.lastUsage?.cost ?? 0,
		usage,
		stopReason: aborted ? 'interrupted' : 'end_turn',
	};
}

function mapUsage(raw: AssistantUsageData | null): TokenUsage {
	if (!raw) {
		return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	}
	return {
		inputTokens: raw.inputTokens ?? 0,
		outputTokens: raw.outputTokens ?? 0,
		cacheCreationInputTokens: raw.cacheWriteTokens ?? 0,
		cacheReadInputTokens: raw.cacheReadTokens ?? 0,
	};
}
