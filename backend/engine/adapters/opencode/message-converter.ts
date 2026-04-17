/**
 * Open Code → EngineOutput Converter
 *
 * Converts Open Code SDK messages and parts into EngineOutput (unified types)
 * with type-safe tool input normalization.
 *
 * Content blocks are split into separate messages:
 * - Consecutive text blocks → one message
 * - Each tool_use block → its own message
 */

import { resolveOpenCodeToolName } from '../../../mcp';
import type { Message as OCMessage, Part, ToolPart, AssistantMessage } from '@opencode-ai/sdk';
import type {
	EngineOutput,
	UserMessage,
	AssistantMessage as UnifiedAssistantMessage,
	ReasoningMessage,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	ErrorResultEvent,
	SystemInitEvent,
	TextBlock,
	ToolUseBlock,
	ToolResult,
	AssistantContentBlock,
	UserContentBlock,
	TokenUsage,
	StopReason,
	BashInput,
	ReadInput,
	EditInput,
	WriteInput,
	GlobInput,
	GrepInput,
	WebFetchInput,
	WebSearchInput,
	AskUserQuestionInput,
	ListMcpResourcesInput,
	ReadMcpResourceInput,
	TodoWriteInput,
} from '$shared/types/unified';

// ============================================================
// Types
// ============================================================

/** Raw tool input from OpenCode SDK (ToolPart.state.input) */
type OCToolInput = ToolPart['state']['input'];

/**
 * Resolve tool input from ToolPart.
 * Pending tools may have empty input ({}) while data is in state.raw.
 * This ensures we always get the actual input even during progressive rendering.
 */
export function getToolInput(toolPart: ToolPart): OCToolInput {
	const input = toolPart.state.input;
	// If input already has data, use it directly
	if (Object.keys(input).length > 0) return input;

	// Pending state has a raw JSON string — try parsing it
	if (toolPart.state.status === 'pending') {
		const raw = toolPart.state.raw;
		if (raw) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed === 'object' && parsed !== null) {
					return parsed as OCToolInput;
				}
			} catch {
				// Incomplete JSON during streaming — will get full input in next update
			}
		}
	}

	return input;
}

/**
 * Normalized tool input types (unified camelCase format).
 */
type NormalizedToolInput =
	| BashInput | ReadInput | EditInput | WriteInput
	| GlobInput | GrepInput | WebFetchInput | WebSearchInput
	| AskUserQuestionInput | TodoWriteInput
	| ListMcpResourcesInput | ReadMcpResourceInput
	| Record<string, unknown>;

// ============================================================
// Tool Name Mapping
// ============================================================

/**
 * OpenCode tool names → Claude Code tool names (for UI rendering)
 *
 * Only maps tools that exist in OpenCode SDK:
 * bash, read, edit, write, glob, grep, webfetch, websearch,
 * question, todowrite, todoread, patch, list, skill, lsp
 *
 * @see https://opencode.ai/docs/tools
 */
const TOOL_NAME_MAP: Record<string, string> = {
	// File operations
	'bash': 'Bash',
	'view': 'Read',
	'read': 'Read',
	'write': 'Write',
	'edit': 'Edit',
	'patch': 'Patch',
	// Search & discovery
	'glob': 'Glob',
	'grep': 'Grep',
	'list': 'List',
	// Web
	'fetch': 'WebFetch',
	'web_fetch': 'WebFetch',
	'webfetch': 'WebFetch',
	'web_search': 'WebSearch',
	'websearch': 'WebSearch',
	// Task management
	'todo_write': 'TodoWrite',
	'todowrite': 'TodoWrite',
	'todoread': 'TodoWrite',
	// Agent / sub-agent
	'task': 'Agent',
	// User interaction
	'question': 'AskUserQuestion',
	// Code intelligence & utilities
	'skill': 'Skill',
	'lsp': 'Lsp',
	// MCP (custom servers)
	'list_mcp_resources': 'ListMcpResources',
	'read_mcp_resource': 'ReadMcpResource',
};

/** Map Open Code tool name to Claude Code tool name for UI rendering */
export function mapToolName(openCodeToolName: string): string {
	// Check if this is a custom MCP tool (resolves via single source in backend/mcp)
	const mcpName = resolveOpenCodeToolName(openCodeToolName);
	if (mcpName) return mcpName;

	const lower = openCodeToolName.toLowerCase();
	return TOOL_NAME_MAP[lower] || TOOL_NAME_MAP[openCodeToolName] || openCodeToolName;
}

// ============================================================
// Tool Input Normalizer Helpers
// ============================================================

/** Get string value, checking both snake_case and camelCase keys */
function str(raw: OCToolInput, snakeCase: string, camelCase: string, fallback = ''): string {
	const val = raw[snakeCase] ?? raw[camelCase];
	return val != null ? String(val) : fallback;
}

/** Get optional number from either key variant */
function optNum(raw: OCToolInput, snakeCase: string, camelCase: string): number | undefined {
	const val = raw[snakeCase] ?? raw[camelCase];
	return val != null ? Number(val) : undefined;
}

/** Get optional boolean from either key variant */
function optBool(raw: OCToolInput, snakeCase: string, camelCase: string): boolean | undefined {
	const val = raw[snakeCase] ?? raw[camelCase];
	return val != null ? Boolean(val) : undefined;
}

/** Get optional string from either key variant */
function optStr(raw: OCToolInput, snakeCase: string, camelCase: string): string | undefined {
	const val = raw[snakeCase] ?? raw[camelCase];
	return val != null ? String(val) : undefined;
}

/** Convert camelCase string to snake_case */
function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

// ============================================================
// Per-Tool Input Normalizers
// ============================================================

function normalizeReadInput(raw: OCToolInput): ReadInput {
	const result: ReadInput = {
		filePath: str(raw, 'file_path', 'filePath'),
	};
	const offset = optNum(raw, 'offset', 'offset');
	if (offset != null) result.offset = offset;
	const limit = optNum(raw, 'limit', 'limit');
	if (limit != null) result.limit = limit;
	return result;
}

function normalizeEditInput(raw: OCToolInput): EditInput {
	const result: EditInput = {
		filePath: str(raw, 'file_path', 'filePath'),
		oldString: str(raw, 'old_string', 'oldString'),
		newString: str(raw, 'new_string', 'newString'),
	};
	const replaceAll = optBool(raw, 'replace_all', 'replaceAll');
	if (replaceAll != null) result.replaceAll = replaceAll;
	return result;
}

function normalizeWriteInput(raw: OCToolInput): WriteInput {
	return {
		filePath: str(raw, 'file_path', 'filePath'),
		content: str(raw, 'content', 'content'),
	};
}

function normalizeBashInput(raw: OCToolInput): BashInput {
	const result: BashInput = {
		command: str(raw, 'command', 'command'),
	};
	const timeout = optNum(raw, 'timeout', 'timeout');
	if (timeout != null) result.timeout = timeout;
	const description = optStr(raw, 'description', 'description');
	if (description != null) result.description = description;
	const runInBackground = optBool(raw, 'run_in_background', 'runInBackground');
	if (runInBackground != null) result.runInBackground = runInBackground;
	return result;
}

function normalizeGlobInput(raw: OCToolInput): GlobInput {
	const result: GlobInput = {
		pattern: str(raw, 'pattern', 'pattern'),
	};
	const path = optStr(raw, 'path', 'path');
	if (path != null) result.path = path;
	return result;
}

function normalizeGrepInput(raw: OCToolInput): GrepInput {
	const result: GrepInput = {
		pattern: str(raw, 'pattern', 'pattern'),
	};
	const path = optStr(raw, 'path', 'path');
	if (path != null) result.path = path;
	// OpenCode uses 'include' for file filter
	const glob = optStr(raw, 'glob', 'glob') ?? optStr(raw, 'include', 'include');
	if (glob != null) result.glob = glob;
	const outputMode = optStr(raw, 'output_mode', 'outputMode') as GrepInput['outputMode'];
	if (outputMode != null) result.outputMode = outputMode;
	const type = optStr(raw, 'type', 'type');
	if (type != null) result.type = type;
	const headLimit = optNum(raw, 'head_limit', 'headLimit');
	if (headLimit != null) result.headLimit = headLimit;
	const offset = optNum(raw, 'offset', 'offset');
	if (offset != null) result.offset = offset;
	const multiline = optBool(raw, 'multiline', 'multiline');
	if (multiline != null) result.multiline = multiline;
	const caseInsensitive = optBool(raw, '-i', 'caseInsensitive');
	if (caseInsensitive != null) result.caseInsensitive = caseInsensitive;
	const beforeContext = optNum(raw, '-B', 'beforeContext');
	if (beforeContext != null) result.beforeContext = beforeContext;
	const afterContext = optNum(raw, '-A', 'afterContext');
	if (afterContext != null) result.afterContext = afterContext;
	const context = optNum(raw, '-C', 'context');
	if (context != null) result.context = context;
	const lineNumbers = optBool(raw, '-n', 'lineNumbers');
	if (lineNumbers != null) result.lineNumbers = lineNumbers;
	return result;
}

function normalizeWebFetchInput(raw: OCToolInput): WebFetchInput {
	return {
		url: str(raw, 'url', 'url'),
		// OpenCode uses 'format', unified uses 'prompt'
		prompt: str(raw, 'prompt', 'prompt') || str(raw, 'format', 'format'),
	};
}

function normalizeWebSearchInput(raw: OCToolInput): WebSearchInput {
	const result: WebSearchInput = {
		query: str(raw, 'query', 'query'),
	};
	const allowedDomains = raw.allowed_domains ?? raw.allowedDomains;
	if (Array.isArray(allowedDomains) && allowedDomains.length) {
		result.allowedDomains = allowedDomains as string[];
	}
	const blockedDomains = raw.blocked_domains ?? raw.blockedDomains;
	if (Array.isArray(blockedDomains) && blockedDomains.length) {
		result.blockedDomains = blockedDomains as string[];
	}
	return result;
}

function normalizeAskUserQuestionInput(raw: OCToolInput): AskUserQuestionInput {
	return {
		questions: (raw.questions ?? []) as AskUserQuestionInput['questions'],
	};
}

function normalizeListMcpResourcesInput(raw: OCToolInput): ListMcpResourcesInput {
	const result: ListMcpResourcesInput = {};
	const server = optStr(raw, 'server', 'server');
	if (server != null) result.server = server;
	return result;
}

function normalizeReadMcpResourceInput(raw: OCToolInput): ReadMcpResourceInput {
	return {
		server: str(raw, 'server', 'server'),
		uri: str(raw, 'uri', 'uri'),
	};
}

function normalizeTodoWriteInput(raw: OCToolInput): TodoWriteInput {
	return {
		todos: (raw.todos ?? []) as TodoWriteInput['todos'],
	};
}

// ============================================================
// Normalizer Dispatcher
// ============================================================

/**
 * Normalize OpenCode tool input → Claude Code tool input format.
 * Handles camelCase → snake_case conversion and field name differences.
 */
function normalizeToolInput(claudeToolName: string, raw: OCToolInput): NormalizedToolInput {
	// Custom MCP tools (mcp__*) — pass input through as-is
	if (claudeToolName.startsWith('mcp__')) {
		return raw as NormalizedToolInput;
	}

	switch (claudeToolName) {
		case 'Read': return normalizeReadInput(raw);
		case 'Edit': return normalizeEditInput(raw);
		case 'Write': return normalizeWriteInput(raw);
		case 'Bash': return normalizeBashInput(raw);
		case 'Glob': return normalizeGlobInput(raw);
		case 'Grep': return normalizeGrepInput(raw);
		case 'WebFetch': return normalizeWebFetchInput(raw);
		case 'WebSearch': return normalizeWebSearchInput(raw);
		case 'AskUserQuestion': return normalizeAskUserQuestionInput(raw);
		case 'ListMcpResources': return normalizeListMcpResourcesInput(raw);
		case 'ReadMcpResource': return normalizeReadMcpResourceInput(raw);
		case 'TodoWrite': return normalizeTodoWriteInput(raw);
		default: {
			// Unknown tool: generic camelCase → snake_case key normalization
			const normalized: Record<string, string | number | boolean> = {};
			for (const [key, value] of Object.entries(raw)) {
				normalized[camelToSnake(key)] = value as string | number | boolean;
			}
			return normalized as NormalizedToolInput;
		}
	}
}

// ============================================================
// Tool Error Detection
// ============================================================

/**
 * Common error prefixes in tool output content.
 * OpenCode SDK may mark a tool as 'completed' even when the output is an error
 * (e.g. "Error: File not found"). These patterns detect such cases.
 */
const ERROR_CONTENT_PATTERNS = [
	/^Error:\s/i,
	/^ENOENT:\s/i,
	/^EPERM:\s/i,
	/^EACCES:\s/i,
	/^Command failed/i,
	/^Permission denied/i,
];

/**
 * Determine if a tool result should be marked as is_error.
 * Returns true when the tool part status is 'error', OR when the output
 * content matches a known error pattern (for tools that complete with error output).
 */
function isToolError(status: string, content: string): boolean {
	if (status === 'error') return true;
	if (!content || status !== 'completed') return false;
	return ERROR_CONTENT_PATTERNS.some(pattern => pattern.test(content));
}

// ============================================================
// Stop Reason Mapping
// ============================================================

/** Map OpenCode finish reason → unified StopReason */
function mapStopReason(finish: string | undefined): StopReason | null {
	switch (finish) {
		case 'tool-calls': return 'tool_use';
		case 'stop': return 'end_turn';
		case 'length': return 'max_tokens';
		default: return finish ? 'end_turn' : null;
	}
}

/** Map OpenCode tokens → unified TokenUsage */
function mapUsage(tokens: { input?: number; output?: number; cache?: { write?: number; read?: number } } | undefined): TokenUsage | null {
	if (!tokens) return null;
	return {
		inputTokens: tokens.input || 0,
		outputTokens: tokens.output || 0,
		cacheCreationInputTokens: tokens.cache?.write || 0,
		cacheReadInputTokens: tokens.cache?.read || 0,
	};
}

// ============================================================
// Public Converters
// ============================================================

/**
 * Convert Open Code user message → UserMessage (unified)
 */
export function convertUserMessage(
	ocMessage: OCMessage,
	ocParts: Part[],
	sessionId: string
): UserMessage {
	const content: UserContentBlock[] = [];

	for (const part of ocParts) {
		if (part.type === 'text') {
			content.push({ type: 'text', text: part.text || '' });
		}
	}

	if (content.length === 0) {
		content.push({ type: 'text', text: '' });
	}

	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: ocMessage.id || crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: { type: 'opencode' as const, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
		sender: { id: '', name: '' },
		content,
		synthetic: false,
	};
}

/**
 * Convert Open Code assistant message + parts → EngineOutput[]
 *
 * Splits content into separate messages:
 * - Consecutive text blocks → one message
 * - Each tool_use block → its own message
 */
export function convertAssistantMessages(
	ocMessage: OCMessage,
	ocParts: Part[],
	sessionId: string
): EngineOutput[] {
	// 1. Build typed content blocks from parts
	const allBlocks: AssistantContentBlock[] = [];

	for (const part of ocParts) {
		if (part.type === 'text') {
			allBlocks.push({ type: 'text', text: part.text || '' } as TextBlock);
		} else if (part.type === 'tool') {
			const toolPart = part as ToolPart;
			const claudeName = mapToolName(toolPart.tool || 'unknown');
			const resolvedInput = getToolInput(toolPart);
			const normalizedInput = normalizeToolInput(claudeName, resolvedInput);
			const toolUseId = toolPart.callID || toolPart.id || crypto.randomUUID();

			let result: ToolResult | null = null;
			if (toolPart.state.status === 'completed') {
				const output = toolPart.state.output || '';
				result = {
					type: 'tool_result',
					toolUseId,
					content: output,
					isError: isToolError('completed', output),
				};
			} else if (toolPart.state.status === 'error') {
				result = {
					type: 'tool_result',
					toolUseId,
					content: toolPart.state.error || 'Tool execution failed',
					isError: true,
				};
			}

			allBlocks.push({
				type: 'tool_use',
				id: toolUseId,
				name: claudeName,
				input: normalizedInput,
				result,
				subActivities: [],
				skillPrompt: null,
				interrupted: false,
			} as ToolUseBlock);
		} else if (part.type === 'subtask') {
			const subtaskPart = part as any;
			allBlocks.push({
				type: 'tool_use',
				id: subtaskPart.id || crypto.randomUUID(),
				name: 'Agent',
				input: {
					prompt: subtaskPart.prompt || '',
					description: subtaskPart.description || '',
					subagentType: subtaskPart.agent || 'general-purpose',
				},
				result: null,
				subActivities: [],
				skillPrompt: null,
				interrupted: false,
			} as ToolUseBlock);
		}
		// Skip: reasoning, step-start, step-finish, snapshot, patch, agent, retry, compaction
	}

	// 2. Split into groups: consecutive text → one group, each tool_use → its own group
	const groups: AssistantContentBlock[][] = [];
	let currentTextGroup: TextBlock[] = [];

	for (const block of allBlocks) {
		if (block.type === 'text') {
			currentTextGroup.push(block);
		} else {
			if (currentTextGroup.length > 0) {
				groups.push([...currentTextGroup]);
				currentTextGroup = [];
			}
			groups.push([block]);
		}
	}
	if (currentTextGroup.length > 0) {
		groups.push([...currentTextGroup]);
	}
	if (groups.length === 0) {
		groups.push([{ type: 'text', text: '' } as TextBlock]);
	}

	// 3. Build unified messages from groups
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const providerID = assistantMsg?.providerID || '';
	const modelID = assistantMsg?.modelID || '';
	const mappedStop = mapStopReason(assistantMsg?.finish);
	const usage = mapUsage(assistantMsg?.tokens);

	const messages: EngineOutput[] = [];
	const baseId = ocMessage.id || crypto.randomUUID();

	for (let i = 0; i < groups.length; i++) {
		const isLast = i === groups.length - 1;
		const group = groups[i];
		const hasToolUse = group.some(b => b.type === 'tool_use');

		let stopReason: StopReason | null;
		if (isLast) {
			stopReason = mappedStop;
		} else if (hasToolUse) {
			stopReason = 'tool_use';
		} else {
			stopReason = null;
		}

		const msg: UnifiedAssistantMessage = {
			type: 'assistant',
			createdAt: new Date().toISOString(),
			messageId: i === 0 ? baseId : crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine: { type: 'opencode' as const, provider: providerID, model: { id: modelID, name: '' }, account: { id: 0, name: '' } },
			content: group,
			stopReason,
			usage: isLast ? usage : null,
		};
		messages.push(msg);
	}

	return messages;
}

/**
 * Convert Open Code result/completion → ResultEvent
 */
export function convertResultMessage(
	ocMessage: OCMessage,
	sessionId: string
): EngineOutput {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;

	if (assistantMsg?.error) {
		return {
			type: 'result',
			subtype: 'error_during_execution',
			sessionId,
			errors: [JSON.stringify(assistantMsg.error)],
		} as ErrorResultEvent;
	}

	return {
		type: 'result',
		subtype: 'success',
		sessionId,
		numTurns: 1,
		totalCostUsd: assistantMsg?.cost || 0,
		usage: mapUsage(assistantMsg?.tokens) || {
			inputTokens: 0, outputTokens: 0,
			cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
		},
		stopReason: assistantMsg?.finish || null,
	} as SuccessResultEvent;
}

/**
 * Convert Open Code system/init event → SystemInitEvent
 */
export function convertSystemInitMessage(sessionId: string, model: string): SystemInitEvent {
	return {
		type: 'system_init',
		sessionId,
		model,
		engine: 'opencode',
		tools: [],
		mcpServers: [],
	};
}

/**
 * Convert Open Code text delta → TextDeltaEvent
 */
export function convertPartialTextDelta(
	text: string,
	sessionId: string,
): TextDeltaEvent {
	return {
		type: 'stream_event',
		event: 'delta',
		sessionId,
		text,
		reasoning: false,
	};
}

/**
 * Convert Open Code stream start → StreamLifecycleEvent
 */
export function convertStreamStart(sessionId: string): StreamLifecycleEvent {
	return {
		type: 'stream_event',
		event: 'start',
		sessionId,
		reasoning: false,
	};
}

/**
 * Convert Open Code stream stop → StreamLifecycleEvent
 */
export function convertStreamStop(sessionId: string): StreamLifecycleEvent {
	return {
		type: 'stream_event',
		event: 'stop',
		sessionId,
		reasoning: false,
	};
}

/**
 * Convert a single tool part → AssistantMessage with tool_use only (no result).
 * Used for progressive tool rendering.
 */
export function convertToolUseOnly(
	toolPart: ToolPart,
	ocMessage: OCMessage,
	sessionId: string,
	parentToolUseId?: string,
): UnifiedAssistantMessage {
	const claudeName = mapToolName(toolPart.tool || 'unknown');
	const resolvedInput = getToolInput(toolPart);
	const normalizedInput = normalizeToolInput(claudeName, resolvedInput);
	const toolUseId = toolPart.callID || toolPart.id || crypto.randomUUID();

	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const provId = assistantMsg?.providerID || '';
	const mdlId = assistantMsg?.modelID || '';

	return {
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: parentToolUseId || null },
		engine: { type: 'opencode' as const, provider: provId, model: { id: mdlId, name: '' }, account: { id: 0, name: '' } },
		content: [{
			type: 'tool_use',
			id: toolUseId,
			name: claudeName,
			input: normalizedInput,
			result: null,
			subActivities: [],
			skillPrompt: null,
			interrupted: false,
		} as ToolUseBlock],
		stopReason: 'tool_use',
		usage: null,
	};
}

/**
 * Convert reasoning text → ReasoningMessage
 */
export function convertReasoningMessage(
	reasoningText: string,
	ocMessage: OCMessage,
	sessionId: string,
): ReasoningMessage {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const provId = assistantMsg?.providerID || '';
	const mdlId = assistantMsg?.modelID || '';

	return {
		type: 'reasoning',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: { type: 'opencode' as const, provider: provId, model: { id: mdlId, name: '' }, account: { id: 0, name: '' } },
		text: reasoningText,
	};
}

/**
 * Convert reasoning delta → TextDeltaEvent (reasoning: true)
 */
export function convertPartialReasoningDelta(
	text: string,
	sessionId: string,
): TextDeltaEvent {
	return {
		type: 'stream_event',
		event: 'delta',
		sessionId,
		text,
		reasoning: true,
	};
}

/**
 * Convert reasoning stream start → StreamLifecycleEvent (reasoning: true)
 */
export function convertReasoningStreamStart(sessionId: string): StreamLifecycleEvent {
	return {
		type: 'stream_event',
		event: 'start',
		sessionId,
		reasoning: true,
	};
}

/**
 * Convert reasoning stream stop → StreamLifecycleEvent (reasoning: true)
 */
export function convertReasoningStreamStop(sessionId: string): StreamLifecycleEvent {
	return {
		type: 'stream_event',
		event: 'stop',
		sessionId,
		reasoning: true,
	};
}

/**
 * Convert a subtask part → AssistantMessage with Agent tool_use.
 */
export function convertSubtaskToolUseOnly(
	subtaskPart: { id: string; prompt: string; description: string; agent: string },
	ocMessage: OCMessage,
	sessionId: string,
): UnifiedAssistantMessage {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const provId = assistantMsg?.providerID || '';
	const mdlId = assistantMsg?.modelID || '';

	return {
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: { type: 'opencode' as const, provider: provId, model: { id: mdlId, name: '' }, account: { id: 0, name: '' } },
		content: [{
			type: 'tool_use',
			id: subtaskPart.id || crypto.randomUUID(),
			name: 'Agent',
			input: {
				prompt: subtaskPart.prompt || '',
				description: subtaskPart.description || '',
				subagentType: subtaskPart.agent || 'general-purpose',
			},
			result: null,
			subActivities: [],
			skillPrompt: null,
			interrupted: false,
		} as ToolUseBlock],
		stopReason: 'tool_use',
		usage: null,
	};
}

/**
 * Convert a completed/errored tool part → UserMessage with tool_result content.
 */
export function convertToolResultOnly(
	toolPart: ToolPart,
	sessionId: string,
	parentToolUseId?: string,
): UserMessage {
	const toolUseId = toolPart.callID || toolPart.id || crypto.randomUUID();

	let content: string;
	if (toolPart.state.status === 'completed') {
		content = toolPart.state.output || '';
	} else if (toolPart.state.status === 'error') {
		content = toolPart.state.error || 'Tool execution failed';
	} else {
		content = '';
	}

	const hasError = isToolError(toolPart.state.status, content);

	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: parentToolUseId || null },
		engine: { type: 'opencode' as const, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
		sender: { id: '', name: '' },
		content: [{
			type: 'tool_result',
			toolUseId,
			content,
			isError: hasError,
		}],
		synthetic: true,
	};
}
