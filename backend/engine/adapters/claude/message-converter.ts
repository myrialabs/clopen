/**
 * Claude Code SDK → Unified Type Converters
 *
 * Converts SDK-specific message types to EngineOutput (unified types).
 * Uses proper SDK types (SDKAssistantMessage, SDKUserMessage, etc.)
 * instead of opaque Record<string, unknown> casts.
 *
 * Mirrors the pattern in opencode/message-converter.ts.
 */

import type {
	SDKMessage,
	SDKAssistantMessage,
	SDKUserMessage,
	SDKPartialAssistantMessage,
	SDKResultSuccess,
	SDKResultError,
	SDKSystemMessage,
	SDKCompactBoundaryMessage,
	SDKRateLimitEvent,
} from '@anthropic-ai/claude-agent-sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
	EngineOutput,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	CompactBoundaryMessage,
	UserContentBlock,
	AssistantContentBlock,
	ToolUseBlock,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	ErrorResultEvent,
	SystemInitEvent,
	RateLimitEvent,
	TokenUsage,
	StopReason,
} from '$shared/types/unified';

// ============================================================
// Helper Mappers
// ============================================================

/** Map SDK stop_reason to unified StopReason */
function mapStopReason(sdkStop: string | null | undefined): StopReason | null {
	switch (sdkStop) {
		case 'end_turn': return 'end_turn';
		case 'tool_use': return 'tool_use';
		case 'max_tokens': return 'max_tokens';
		case 'interrupted': return 'interrupted';
		default: return sdkStop ? 'end_turn' : null;
	}
}

/** Map SDK BetaUsage to unified TokenUsage */
function mapUsage(sdkUsage: BetaUsage | null | undefined): TokenUsage | null {
	if (!sdkUsage) return null;
	return {
		inputTokens: sdkUsage.input_tokens || 0,
		outputTokens: sdkUsage.output_tokens || 0,
		cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
		cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
	};
}

/** Map raw usage from result messages (NonNullableUsage shape) */
function mapRawUsage(raw: Record<string, number> | null | undefined): TokenUsage {
	if (!raw) return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	return {
		inputTokens: raw.input_tokens || 0,
		outputTokens: raw.output_tokens || 0,
		cacheCreationInputTokens: raw.cache_creation_input_tokens || 0,
		cacheReadInputTokens: raw.cache_read_input_tokens || 0,
	};
}

// ============================================================
// Tool Input Converter (snake_case → camelCase)
// ============================================================

/** Grep option mapping for dash-prefixed parameters → camelCase */
const GREP_OPTION_MAP: Record<string, string> = {
	'-i': 'caseInsensitive',
	'-n': 'lineNumbers',
	'-A': 'afterContext',
	'-B': 'beforeContext',
	'-C': 'context',
};

/** Convert snake_case string to camelCase */
function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Convert raw SDK tool input to unified camelCase format.
 * Handles standard snake_case → camelCase and Grep's dash-prefixed options.
 * Already-camelCase properties (e.g. multiline, activeForm) pass through unchanged.
 */
function convertToolInput(toolName: string, raw: Record<string, unknown>): Record<string, unknown> {
	const converted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (toolName === 'Grep' && key in GREP_OPTION_MAP) {
			converted[GREP_OPTION_MAP[key]] = value;
		} else {
			converted[snakeToCamel(key)] = value;
		}
	}
	return converted;
}

// ============================================================
// Content Block Converters
// ============================================================

/** Convert SDK BetaContentBlock[] to unified AssistantContentBlock[] (excluding thinking) */
export function mapAssistantContent(sdkContent: BetaContentBlock[]): AssistantContentBlock[] {
	const blocks: AssistantContentBlock[] = [];
	for (const block of sdkContent) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: block.text });
				break;
			case 'tool_use':
				blocks.push({
					type: 'tool_use',
					id: block.id,
					name: block.name === 'Task' ? 'Agent' : block.name,
					input: convertToolInput(block.name, block.input as Record<string, unknown>),
					result: null,
					subActivities: [],
					skillPrompt: null,
					interrupted: false,
				} as ToolUseBlock);
				break;
		}
	}
	return blocks;
}

/** Convert SDK user content to unified UserContentBlock[] */
export function mapUserContent(sdkContent: string | Array<Record<string, unknown>>): UserContentBlock[] {
	if (typeof sdkContent === 'string') {
		return [{ type: 'text', text: sdkContent }];
	}
	const blocks: UserContentBlock[] = [];
	for (const block of sdkContent) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: block.text as string });
				break;
			case 'tool_result':
				blocks.push({
					type: 'tool_result',
					toolUseId: block.tool_use_id as string,
					content: (block.content as string) || '',
					isError: !!(block.is_error),
				});
				break;
			case 'image': {
				const source = block.source as Record<string, unknown> | undefined;
				blocks.push({
					type: 'image',
					mediaType: (source?.media_type as string) || '',
					data: (source?.data as string) || '',
				});
				break;
			}
			case 'document': {
				const source = block.source as Record<string, unknown> | undefined;
				blocks.push({
					type: 'document',
					mediaType: (source?.media_type as string) || '',
					data: (source?.data as string) || '',
					title: (block.title as string) || null,
				});
				break;
			}
		}
	}
	if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
	return blocks;
}

// ============================================================
// Message Converters
// ============================================================

/** Convert SDKAssistantMessage → ReasoningMessage (if thinking) + AssistantMessage */
export function convertAssistantMessage(msg: SDKAssistantMessage): EngineOutput[] {
	const sessionId = msg.session_id;
	const betaMessage = msg.message;
	const content = betaMessage.content;
	const outputs: EngineOutput[] = [];

	// Extract thinking blocks → ReasoningMessage
	const thinkingBlocks = content.filter(b => b.type === 'thinking');
	if (thinkingBlocks.length > 0) {
		const reasoningText = thinkingBlocks
			.map(b => b.type === 'thinking' ? b.thinking : '')
			.join('\n');
		const reasoning: ReasoningMessage = {
			type: 'reasoning',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine: { type: 'claude-code', provider: 'anthropic', model: { id: betaMessage.model || '', name: '' }, account: { id: 0, name: '' } },
			text: reasoningText,
		};
		outputs.push(reasoning);
	}

	// Build AssistantMessage with non-thinking content
	const otherBlocks = content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
	const assistantContent = mapAssistantContent(
		otherBlocks.length > 0 ? otherBlocks : [{ type: 'text', text: '', citations: null } as BetaContentBlock]
	);

	const assistant: AssistantMessage = {
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId: msg.uuid || crypto.randomUUID(),
		sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
		engine: { type: 'claude-code', provider: 'anthropic', model: { id: betaMessage.model || '', name: '' }, account: { id: 0, name: '' } },
		content: assistantContent,
		stopReason: mapStopReason(betaMessage.stop_reason),
		usage: mapUsage(betaMessage.usage),
	};
	outputs.push(assistant);

	return outputs;
}

/** Convert SDKUserMessage → UserMessage */
export function convertUserMessage(msg: SDKUserMessage): UserMessage {
	const sdkContent = msg.message.content;
	const content = mapUserContent(sdkContent as string | Array<Record<string, unknown>>);

	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: msg.uuid || crypto.randomUUID(),
		sessionId: msg.session_id || null,
		parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
		engine: { type: 'claude-code', provider: 'anthropic', model: { id: '', name: '' }, account: { id: 0, name: '' } },
		sender: { id: '', name: '' },
		content,
		synthetic: true, // SDK-generated tool_result messages
	};
}

/** Convert SDKPartialAssistantMessage (stream_event) → TextDeltaEvent | StreamLifecycleEvent */
export function convertStreamEvent(msg: SDKPartialAssistantMessage): EngineOutput[] {
	const sessionId = msg.session_id;
	const event = msg.event;
	const outputs: EngineOutput[] = [];

	switch (event.type) {
		case 'message_start':
		case 'message_stop': {
			const lifecycle: StreamLifecycleEvent = {
				type: 'stream_event',
				event: event.type === 'message_start' ? 'start' : 'stop',
				sessionId,
				reasoning: false,
			};
			outputs.push(lifecycle);
			break;
		}

		case 'content_block_start': {
			const blockType = event.content_block.type;
			if (blockType === 'thinking') {
				outputs.push({ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent);
			} else if (blockType === 'text') {
				outputs.push({ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent);
			}
			break;
		}

		case 'content_block_delta': {
			const delta = event.delta;
			if (delta.type === 'thinking_delta') {
				const text: TextDeltaEvent = {
					type: 'stream_event',
					event: 'delta',
					sessionId,
					text: delta.thinking || '',
					reasoning: true,
				};
				outputs.push(text);
			} else if (delta.type === 'text_delta') {
				const text: TextDeltaEvent = {
					type: 'stream_event',
					event: 'delta',
					sessionId,
					text: delta.text || '',
					reasoning: false,
				};
				outputs.push(text);
			}
			break;
		}

		case 'content_block_stop': {
			outputs.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false } as StreamLifecycleEvent);
			break;
		}
	}

	return outputs;
}

/** Convert SDKResultSuccess → SuccessResultEvent */
export function convertResultSuccess(msg: SDKResultSuccess): SuccessResultEvent {
	return {
		type: 'result',
		subtype: 'success',
		sessionId: msg.session_id,
		numTurns: msg.num_turns || 0,
		totalCostUsd: msg.total_cost_usd || 0,
		usage: mapRawUsage(msg.usage as unknown as Record<string, number>),
		stopReason: msg.stop_reason || null,
	};
}

/** Convert SDKResultError → ErrorResultEvent */
export function convertResultError(msg: SDKResultError): ErrorResultEvent {
	return {
		type: 'result',
		subtype: msg.subtype === 'error_max_turns' ? 'error_max_turns'
			: msg.subtype === 'error_max_budget_usd' ? 'error_max_budget'
			: 'error_during_execution',
		sessionId: msg.session_id,
		errors: msg.errors || [],
	};
}

/** Convert SDKSystemMessage (init) → SystemInitEvent */
export function convertSystemInit(msg: SDKSystemMessage): SystemInitEvent {
	return {
		type: 'system_init',
		sessionId: msg.session_id,
		model: msg.model || '',
		engine: 'claude-code',
		tools: msg.tools || [],
		mcpServers: (msg.mcp_servers || []).map(s => ({
			name: s.name || '',
			status: (s.status as 'connected' | 'disconnected' | 'error') || 'disconnected',
		})),
	};
}

/** Convert SDKCompactBoundaryMessage → CompactBoundaryMessage */
export function convertCompactBoundary(msg: SDKCompactBoundaryMessage): CompactBoundaryMessage {
	return {
		type: 'compact_boundary',
		createdAt: new Date().toISOString(),
		messageId: msg.uuid || crypto.randomUUID(),
		sessionId: msg.session_id,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: { type: 'claude-code', provider: 'anthropic', model: { id: '', name: '' }, account: { id: 0, name: '' } },
		trigger: msg.compact_metadata.trigger,
		preTokens: msg.compact_metadata.pre_tokens || 0,
	};
}

/** Convert SDKRateLimitEvent → RateLimitEvent (returns null for non-actionable 'allowed' status) */
export function convertRateLimit(msg: SDKRateLimitEvent): RateLimitEvent | null {
	const info = msg.rate_limit_info;
	// Only emit for actual warnings/rejections — 'allowed' is just informational
	if (info.status === 'allowed') return null;
	return {
		type: 'rate_limit',
		sessionId: msg.session_id,
		status: info.status === 'rejected' ? 'rejected' : 'allowed_warning',
		utilization: info.utilization || 0,
		resetsAt: info.resetsAt || null,
	};
}

// ============================================================
// Top-Level Converter
// ============================================================

/**
 * Convert a single SDKMessage to zero or more EngineOutput events.
 *
 * Dispatches on the SDK message discriminant using proper SDK types.
 * Handles thinking block extraction: assistant messages with thinking
 * blocks yield a ReasoningMessage first, then the AssistantMessage
 * with thinking blocks stripped.
 */
export function* convertSdkMessage(msg: SDKMessage): Generator<EngineOutput> {
	switch (msg.type) {
		case 'assistant':
			for (const output of convertAssistantMessage(msg as SDKAssistantMessage)) {
				yield output;
			}
			break;

		case 'user':
			// SDKUserMessage and SDKUserMessageReplay both have type: 'user'
			yield convertUserMessage(msg as SDKUserMessage);
			break;

		case 'stream_event':
			for (const output of convertStreamEvent(msg as SDKPartialAssistantMessage)) {
				yield output;
			}
			break;

		case 'result':
			if (msg.subtype === 'success') {
				yield convertResultSuccess(msg as SDKResultSuccess);
			} else {
				yield convertResultError(msg as SDKResultError);
			}
			break;

		case 'system': {
			const systemMsg = msg as SDKSystemMessage | SDKCompactBoundaryMessage;
			if ('subtype' in systemMsg) {
				if (systemMsg.subtype === 'init') {
					yield convertSystemInit(systemMsg as SDKSystemMessage);
				} else if (systemMsg.subtype === 'compact_boundary') {
					yield convertCompactBoundary(systemMsg as SDKCompactBoundaryMessage);
				}
			}
			break;
		}

		case 'rate_limit_event': {
			const rlEvent = convertRateLimit(msg as SDKRateLimitEvent);
			if (rlEvent) yield rlEvent;
			break;
		}

		// Transient SDK message types — skip
		default:
			break;
	}
}

// ============================================================
// Prompt Converter (Unified → SDK)
// ============================================================

/**
 * Convert a UserMessage prompt to SDKUserMessage format for the Claude SDK.
 */
export function toSdkUserMessage(msg: UserMessage): SDKUserMessage {
	const sdkContent: Array<Record<string, unknown>> = [];

	for (const block of msg.content) {
		switch (block.type) {
			case 'text':
				sdkContent.push({ type: 'text', text: block.text });
				break;
			case 'image':
				sdkContent.push({
					type: 'image',
					source: { type: 'base64', media_type: block.mediaType, data: block.data },
				});
				break;
			case 'document':
				sdkContent.push({
					type: 'document',
					source: { type: 'base64', media_type: block.mediaType, data: block.data },
					title: block.title,
				});
				break;
			case 'tool_result':
				sdkContent.push({
					type: 'tool_result',
					tool_use_id: block.toolUseId,
					content: block.content,
					is_error: block.isError,
				});
				break;
		}
	}

	// SDK accepts string for simple text-only prompts
	const content = sdkContent.length === 1 && sdkContent[0].type === 'text'
		? sdkContent[0].text as string
		: sdkContent;

	return {
		type: 'user',
		uuid: msg.messageId,
		session_id: msg.sessionId,
		parent_tool_use_id: msg.parent.toolUseId,
		message: { role: 'user', content },
	} as unknown as SDKUserMessage;
}
