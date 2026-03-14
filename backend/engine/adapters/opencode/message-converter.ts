/**
 * Open Code → Claude SDK Message Converter
 *
 * Converts Open Code SDK messages and parts into Claude SDK format (SDKMessage)
 * with type-safe tool input normalization (camelCase → snake_case).
 *
 * Content blocks are split into separate messages:
 * - Consecutive text blocks → one message
 * - Each tool_use block → its own message
 */

import type { SDKMessage, EngineSDKMessage } from '$shared/types/messaging';
import type { ToolResult } from '$shared/types/messaging/tool';
import { resolveOpenCodeToolName } from '../../../mcp';
import type { Message as OCMessage, Part, ToolPart, AssistantMessage } from '@opencode-ai/sdk';
import type {
	BashInput,
	FileReadInput,
	FileEditInput,
	FileWriteInput,
	GlobInput,
	GrepInput,
	WebFetchInput,
	WebSearchInput,
	AskUserQuestionInput,
	ListMcpResourcesInput,
	ReadMcpResourceInput,
	TodoWriteInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

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
 * Normalized tool input types.
 * Only includes tools that exist in OpenCode SDK:
 * bash, read, edit, write, glob, grep, webfetch, websearch,
 * question, todowrite, todoread, patch, list, skill, lsp
 */
type NormalizedToolInput =
	| BashInput | FileReadInput | FileEditInput | FileWriteInput
	| GlobInput | GrepInput | WebFetchInput | WebSearchInput
	| AskUserQuestionInput | TodoWriteInput
	| ListMcpResourcesInput | ReadMcpResourceInput;

/** Text content block */
interface TextContentBlock {
	type: 'text';
	text: string;
}

/** Tool use content block with optional result */
interface ToolUseContentBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: NormalizedToolInput;
	$result?: ToolResult;
}

type ContentBlock = TextContentBlock | ToolUseContentBlock;

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

function normalizeReadInput(raw: OCToolInput): FileReadInput {
	const result: FileReadInput = {
		file_path: str(raw, 'file_path', 'filePath'),
	};
	const offset = optNum(raw, 'offset', 'offset');
	if (offset != null) result.offset = offset;
	const limit = optNum(raw, 'limit', 'limit');
	if (limit != null) result.limit = limit;
	return result;
}

function normalizeEditInput(raw: OCToolInput): FileEditInput {
	const result: FileEditInput = {
		file_path: str(raw, 'file_path', 'filePath'),
		old_string: str(raw, 'old_string', 'oldString'),
		new_string: str(raw, 'new_string', 'newString'),
	};
	const replaceAll = optBool(raw, 'replace_all', 'replaceAll');
	if (replaceAll != null) result.replace_all = replaceAll;
	return result;
}

function normalizeWriteInput(raw: OCToolInput): FileWriteInput {
	return {
		file_path: str(raw, 'file_path', 'filePath'),
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
	if (runInBackground != null) result.run_in_background = runInBackground;
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
	// OpenCode uses 'include' for file filter, Claude Code uses 'glob'
	const glob = optStr(raw, 'glob', 'glob') ?? optStr(raw, 'include', 'include');
	if (glob != null) result.glob = glob;
	const outputMode = optStr(raw, 'output_mode', 'outputMode') as GrepInput['output_mode'];
	if (outputMode != null) result.output_mode = outputMode;
	const type = optStr(raw, 'type', 'type');
	if (type != null) result.type = type;
	const headLimit = optNum(raw, 'head_limit', 'headLimit');
	if (headLimit != null) result.head_limit = headLimit;
	const offset = optNum(raw, 'offset', 'offset');
	if (offset != null) result.offset = offset;
	const multiline = optBool(raw, 'multiline', 'multiline');
	if (multiline != null) result.multiline = multiline;
	const caseInsensitive = optBool(raw, '-i', '-i');
	if (caseInsensitive != null) result['-i'] = caseInsensitive;
	const beforeContext = optNum(raw, '-B', '-B');
	if (beforeContext != null) result['-B'] = beforeContext;
	const afterContext = optNum(raw, '-A', '-A');
	if (afterContext != null) result['-A'] = afterContext;
	const context = optNum(raw, '-C', '-C');
	if (context != null) result['-C'] = context;
	const lineNumbers = optBool(raw, '-n', '-n');
	if (lineNumbers != null) result['-n'] = lineNumbers;
	return result;
}

function normalizeWebFetchInput(raw: OCToolInput): WebFetchInput {
	return {
		url: str(raw, 'url', 'url'),
		// OpenCode uses 'format', Claude Code uses 'prompt'
		prompt: str(raw, 'prompt', 'prompt') || str(raw, 'format', 'format'),
	};
}

function normalizeWebSearchInput(raw: OCToolInput): WebSearchInput {
	const result: WebSearchInput = {
		query: str(raw, 'query', 'query'),
	};
	const allowedDomains = raw.allowed_domains ?? raw.allowedDomains;
	if (Array.isArray(allowedDomains) && allowedDomains.length) {
		result.allowed_domains = allowedDomains as string[];
	}
	const blockedDomains = raw.blocked_domains ?? raw.blockedDomains;
	if (Array.isArray(blockedDomains) && blockedDomains.length) {
		result.blocked_domains = blockedDomains as string[];
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

/** Map OpenCode finish reason → Claude Code stop_reason */
function mapStopReason(finish: string | undefined): string | null {
	switch (finish) {
		case 'tool-calls': return 'tool_use';
		case 'stop': return 'end_turn';
		case 'length': return 'max_tokens';
		default: return finish || 'end_turn';
	}
}

// ============================================================
// Message Builder Helper
// ============================================================

interface AssistantMessageParams {
	content: ContentBlock[];
	ocMessage: OCMessage;
	modelId: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens: number;
		cache_read_input_tokens: number;
	};
	sessionId: string;
	stopReason: string | null;
	uuid: string;
	parentToolUseId?: string | null;
}

/** Build a single SDKAssistantMessage from content blocks */
function buildAssistantSDKMessage(params: AssistantMessageParams): SDKMessage {
	return {
		type: 'assistant',
		message: {
			model: params.modelId,
			id: params.uuid,
			type: 'message',
			role: 'assistant',
			content: params.content,
			stop_reason: params.stopReason,
			stop_sequence: null,
			...(params.usage && { usage: params.usage }),
			context_management: null
		},
		parent_tool_use_id: params.parentToolUseId ?? null,
		session_id: params.sessionId,
		uuid: params.uuid
	} as unknown as SDKMessage;
}

// ============================================================
// Public Converters
// ============================================================

/**
 * Convert Open Code user message → SDKMessage (user type)
 */
export function convertUserMessage(
	ocMessage: OCMessage,
	ocParts: Part[],
	sessionId: string
): SDKMessage {
	const textBlocks: TextContentBlock[] = [];

	for (const part of ocParts) {
		if (part.type === 'text') {
			textBlocks.push({ type: 'text', text: part.text || '' });
		}
	}

	if (textBlocks.length === 0) {
		textBlocks.push({ type: 'text', text: '' });
	}

	return {
		type: 'user',
		uuid: ocMessage.id || crypto.randomUUID(),
		session_id: sessionId,
		parent_tool_use_id: null,
		message: {
			role: 'user',
			content: textBlocks.length === 1
				? textBlocks[0].text
				: textBlocks
		}
	} as unknown as SDKMessage;
}

/**
 * Convert Open Code assistant message + parts → SDKMessage[] (split by content type)
 *
 * Splits content into separate messages:
 * - Consecutive text blocks → one message
 * - Each tool_use block → its own message
 *
 * This matches Claude Code's UI behavior where each tool call is a separate bubble.
 */
export function convertAssistantMessages(
	ocMessage: OCMessage,
	ocParts: Part[],
	sessionId: string
): SDKMessage[] {
	// 1. Build typed content blocks from parts
	const allBlocks: ContentBlock[] = [];

	for (const part of ocParts) {
		if (part.type === 'text') {
			allBlocks.push({ type: 'text', text: part.text || '' });
		} else if (part.type === 'tool') {
			const toolPart = part as ToolPart;
			const claudeName = mapToolName(toolPart.tool || 'unknown');
			const resolvedInput = getToolInput(toolPart);
			const normalizedInput = normalizeToolInput(claudeName, resolvedInput);

			const block: ToolUseContentBlock = {
				type: 'tool_use',
				id: toolPart.callID || toolPart.id || crypto.randomUUID(),
				name: claudeName,
				input: normalizedInput,
			};

			if (toolPart.state.status === 'completed') {
				const output = toolPart.state.output || '';
				block.$result = {
					type: 'tool_result',
					tool_use_id: block.id,
					content: output,
					...(isToolError('completed', output) && { is_error: true }),
				};
			} else if (toolPart.state.status === 'error') {
				block.$result = {
					type: 'tool_result',
					tool_use_id: block.id,
					content: toolPart.state.error || 'Tool execution failed',
					is_error: true,
				};
			}

			allBlocks.push(block);
		}
		else if (part.type === 'subtask') {
			// Subtask = Agent/sub-agent invocation
			const subtaskPart = part as any;
			allBlocks.push({
				type: 'tool_use',
				id: subtaskPart.id || crypto.randomUUID(),
				name: 'Agent',
				input: {
					prompt: subtaskPart.prompt || '',
					description: subtaskPart.description || '',
					subagent_type: subtaskPart.agent || 'general-purpose',
				} as NormalizedToolInput,
			});
		}
		// Skip: reasoning, step-start, step-finish, snapshot, patch, agent, retry, compaction
	}

	// 2. Split into groups: consecutive text → one group, each tool_use → its own group
	const groups: ContentBlock[][] = [];
	let currentTextGroup: TextContentBlock[] = [];

	for (const block of allBlocks) {
		if (block.type === 'text') {
			currentTextGroup.push(block);
		} else {
			// Flush accumulated text blocks as a group
			if (currentTextGroup.length > 0) {
				groups.push([...currentTextGroup]);
				currentTextGroup = [];
			}
			// Each tool_use is its own group
			groups.push([block]);
		}
	}
	// Flush remaining text
	if (currentTextGroup.length > 0) {
		groups.push([...currentTextGroup]);
	}

	// If no content at all, add an empty text block
	if (groups.length === 0) {
		groups.push([{ type: 'text', text: '' }]);
	}

	// 3. Build SDKMessages from groups
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const modelId = assistantMsg ? `${assistantMsg.providerID}/${assistantMsg.modelID}` : '';
	const mappedStop = mapStopReason(assistantMsg?.finish);
	const usage = assistantMsg?.tokens ? {
		input_tokens: assistantMsg.tokens.input || 0,
		output_tokens: assistantMsg.tokens.output || 0,
		cache_creation_input_tokens: assistantMsg.tokens.cache?.write || 0,
		cache_read_input_tokens: assistantMsg.tokens.cache?.read || 0,
	} : undefined;

	const messages: SDKMessage[] = [];
	const baseUuid = ocMessage.id || crypto.randomUUID();

	for (let i = 0; i < groups.length; i++) {
		const isLast = i === groups.length - 1;
		const group = groups[i];
		const hasToolUse = group.some(b => b.type === 'tool_use');

		// Determine stop_reason for this split
		let stopReason: string | null;
		if (isLast) {
			stopReason = mappedStop;
		} else if (hasToolUse) {
			stopReason = 'tool_use';
		} else {
			stopReason = null;
		}

		messages.push(buildAssistantSDKMessage({
			content: group,
			ocMessage,
			modelId,
			// Only the last message carries usage (to avoid double-counting)
			usage: isLast ? usage : undefined,
			sessionId,
			stopReason,
			uuid: i === 0 ? baseUuid : crypto.randomUUID(),
		}));
	}

	return messages;
}

/**
 * Convert Open Code result/completion → SDKResultMessage
 */
export function convertResultMessage(
	ocMessage: OCMessage,
	sessionId: string
): SDKMessage {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;

	return {
		type: 'result',
		subtype: assistantMsg?.error ? 'error_during_execution' : 'success',
		uuid: crypto.randomUUID(),
		session_id: sessionId,
		duration_ms: assistantMsg?.time?.completed
			? (assistantMsg.time.completed - assistantMsg.time.created) * 1000
			: 0,
		duration_api_ms: 0,
		is_error: !!assistantMsg?.error,
		num_turns: 1,
		total_cost_usd: assistantMsg?.cost || 0,
		usage: {
			input_tokens: assistantMsg?.tokens?.input || 0,
			output_tokens: assistantMsg?.tokens?.output || 0,
			cache_creation_input_tokens: assistantMsg?.tokens?.cache?.write || 0,
			cache_read_input_tokens: assistantMsg?.tokens?.cache?.read || 0
		},
		...(assistantMsg?.error
			? { errors: [JSON.stringify(assistantMsg.error)] }
			: { result: '' }
		)
	} as unknown as SDKMessage;
}

/**
 * Convert Open Code system/init event → SDKSystemMessage
 */
export function convertSystemInitMessage(sessionId: string, model: string): SDKMessage {
	return {
		type: 'system',
		subtype: 'init',
		uuid: crypto.randomUUID(),
		session_id: sessionId,
		tools: [],
		mcp_servers: [],
		model,
		permissionMode: 'bypassPermissions',
		cwd: process.cwd(),
		apiKeySource: 'user',
		slash_commands: [],
		skills: [],
		plugins: [],
		claude_code_version: 'opencode',
		output_style: 'text'
	} as unknown as SDKMessage;
}

/**
 * Convert Open Code text delta → SDKPartialAssistantMessage
 */
export function convertPartialTextDelta(
	text: string,
	sessionId: string,
	parentToolUseId: string | null = null
): SDKMessage {
	return {
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text }
		},
		parent_tool_use_id: parentToolUseId,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as SDKMessage;
}

/**
 * Convert Open Code stream start → SDKPartialAssistantMessage
 */
export function convertStreamStart(sessionId: string): SDKMessage {
	return {
		type: 'stream_event',
		event: { type: 'message_start', message: { role: 'assistant', content: [] } },
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as SDKMessage;
}

/**
 * Convert Open Code stream stop → SDKPartialAssistantMessage
 */
export function convertStreamStop(sessionId: string): SDKMessage {
	return {
		type: 'stream_event',
		event: { type: 'message_stop' },
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as SDKMessage;
}

/**
 * Convert a single tool part → assistant message with tool_use only (no $result).
 * Used for progressive tool rendering — tool appears immediately in UI
 * before the tool finishes executing.
 */
export function convertToolUseOnly(
	toolPart: ToolPart,
	ocMessage: OCMessage,
	sessionId: string,
	parentToolUseId: string | null = null,
): SDKMessage {
	const claudeName = mapToolName(toolPart.tool || 'unknown');
	const resolvedInput = getToolInput(toolPart);
	const normalizedInput = normalizeToolInput(claudeName, resolvedInput);
	const toolUseId = toolPart.callID || toolPart.id || crypto.randomUUID();

	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const modelId = assistantMsg ? `${assistantMsg.providerID}/${assistantMsg.modelID}` : '';

	return buildAssistantSDKMessage({
		content: [{
			type: 'tool_use',
			id: toolUseId,
			name: claudeName,
			input: normalizedInput,
		}],
		ocMessage,
		modelId,
		sessionId,
		stopReason: 'tool_use',
		uuid: crypto.randomUUID(),
		parentToolUseId,
	});
}

/**
 * Convert reasoning text → assistant message with metadata.reasoning flag.
 * Displayed as separate "Reasoning" bubble in UI.
 */
export function convertReasoningMessage(
	reasoningText: string,
	ocMessage: OCMessage,
	sessionId: string,
): EngineSDKMessage {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const modelId = assistantMsg ? `${assistantMsg.providerID}/${assistantMsg.modelID}` : '';

	return {
		...buildAssistantSDKMessage({
			content: [{ type: 'text', text: reasoningText }],
			ocMessage,
			modelId,
			sessionId,
			stopReason: null,
			uuid: crypto.randomUUID(),
		}),
		metadata: { reasoning: true },
	};
}

/**
 * Convert reasoning delta → stream event with metadata.reasoning flag.
 */
export function convertPartialReasoningDelta(
	text: string,
	sessionId: string,
): EngineSDKMessage {
	// Synthetic stream event — partial SDK structure by design
	return {
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text }
		},
		metadata: { reasoning: true },
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as EngineSDKMessage;
}

/**
 * Convert reasoning stream start → stream event with metadata.reasoning flag.
 */
export function convertReasoningStreamStart(sessionId: string): EngineSDKMessage {
	// Synthetic stream event — partial SDK structure by design
	return {
		type: 'stream_event',
		event: { type: 'message_start', message: { role: 'assistant', content: [] } },
		metadata: { reasoning: true },
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as EngineSDKMessage;
}

/**
 * Convert reasoning stream stop → stream event with metadata.reasoning flag.
 */
export function convertReasoningStreamStop(sessionId: string): EngineSDKMessage {
	// Synthetic stream event — partial SDK structure by design
	return {
		type: 'stream_event',
		event: { type: 'message_stop' },
		metadata: { reasoning: true },
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: sessionId
	} as unknown as EngineSDKMessage;
}

/**
 * Convert a subtask part → assistant message with Agent tool_use.
 * Used for progressive rendering when OpenCode emits subtask parts.
 */
export function convertSubtaskToolUseOnly(
	subtaskPart: { id: string; prompt: string; description: string; agent: string },
	ocMessage: OCMessage,
	sessionId: string,
): SDKMessage {
	const assistantMsg = ocMessage.role === 'assistant' ? ocMessage as AssistantMessage : null;
	const modelId = assistantMsg ? `${assistantMsg.providerID}/${assistantMsg.modelID}` : '';

	return buildAssistantSDKMessage({
		content: [{
			type: 'tool_use',
			id: subtaskPart.id || crypto.randomUUID(),
			name: 'Agent',
			input: {
				prompt: subtaskPart.prompt || '',
				description: subtaskPart.description || '',
				subagent_type: subtaskPart.agent || 'general-purpose',
			} as NormalizedToolInput,
		}],
		ocMessage,
		modelId,
		sessionId,
		stopReason: 'tool_use',
		uuid: crypto.randomUUID(),
	});
}

/**
 * Convert a completed/errored tool part → user message with tool_result.
 * Sent after the tool finishes executing, matching Claude Code's pattern
 * where tool_result arrives as a separate user message.
 */
export function convertToolResultOnly(
	toolPart: ToolPart,
	sessionId: string,
	parentToolUseId: string | null = null,
): SDKMessage {
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
		uuid: crypto.randomUUID(),
		session_id: sessionId,
		parent_tool_use_id: parentToolUseId,
		message: {
			role: 'user',
			content: [{
				type: 'tool_result',
				tool_use_id: toolUseId,
				content,
				...(hasError && { is_error: true }),
			}]
		}
	} as unknown as SDKMessage;
}
