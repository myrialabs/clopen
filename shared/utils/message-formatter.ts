/**
 * Message Formatter
 *
 * loadMessage() — DB row → UnifiedMessage
 *
 * Handles runtime migration: old SDK format rows are converted to
 * UnifiedMessage on read. New rows are returned as-is.
 */

import type { DatabaseMessage } from '$shared/types/database/schema';
import type {
	UnifiedMessage,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	CompactBoundaryMessage,
	UserContentBlock,
	AssistantContentBlock,
	TextBlock,
	ToolUseBlock,
	ToolResult,
	TokenUsage,
	StopReason,
} from '$shared/types/unified';

/**
 * Load a DatabaseMessage row as UnifiedMessage.
 *
 * DB metadata (id, timestamp, sender, parent) overrides the JSON blob
 * so the DB columns remain the source of truth.
 */
export function loadMessage(
	row: DatabaseMessage,
	overrides?: {
		sender_id?: string | null;
		sender_name?: string | null;
	}
): UnifiedMessage {
	const raw = JSON.parse(row.sdk_message);

	// Already unified format
	if ('sessionId' in raw && raw.sessionId) {
		raw.id = row.id;
		raw.createdAt = row.timestamp;
		raw.parentMessageId = row.parent_message_id || null;
		raw.senderId = overrides?.sender_id ?? row.sender_id ?? raw.senderId ?? null;
		raw.senderName = overrides?.sender_name ?? row.sender_name ?? raw.senderName ?? null;
		return raw as UnifiedMessage;
	}

	// Old SDK format → convert to UnifiedMessage
	return convertOldFormat(raw, row, overrides);
}

// ============================================================================
// Old SDK format conversion (runtime migration)
// ============================================================================

function convertOldFormat(
	raw: Record<string, unknown>,
	row: DatabaseMessage,
	overrides?: {
		sender_id?: string | null;
		sender_name?: string | null;
	}
): UnifiedMessage {
	const base = {
		id: row.id,
		sessionId: row.session_id,
		createdAt: row.timestamp,
		parentMessageId: row.parent_message_id || null,
		senderId: overrides?.sender_id ?? row.sender_id ?? null,
		senderName: overrides?.sender_name ?? row.sender_name ?? null,
		model: null as string | null,
		engine: null as string | null,
	};

	const metadata = raw.metadata as Record<string, unknown> | undefined;
	if (metadata?.engine) base.engine = metadata.engine as string;

	const sdkType = raw.type as string;
	const message = raw.message as Record<string, unknown> | undefined;

	// Reasoning (old format stores as assistant + metadata.reasoning)
	if (metadata?.reasoning === true && sdkType === 'assistant') {
		return { ...base, type: 'reasoning', text: extractText(message) } satisfies ReasoningMessage;
	}

	// Compact boundary (old format stores as type: 'system')
	if (sdkType === 'system') {
		const cb = raw.compactBoundary as Record<string, unknown> | undefined;
		return {
			...base,
			type: 'compact_boundary',
			trigger: (cb?.trigger as 'manual' | 'auto') || 'auto',
			preTokens: (cb?.preTokens as number) || 0,
		} satisfies CompactBoundaryMessage;
	}

	// User message
	if (sdkType === 'user') {
		return {
			...base,
			type: 'user',
			parentToolUseId: (raw.parent_tool_use_id as string) || null,
			content: convertUserContent(message),
			synthetic: (raw.isSynthetic as boolean) || false,
		} satisfies UserMessage;
	}

	// Assistant message
	if (sdkType === 'assistant') {
		return {
			...base,
			type: 'assistant',
			parentToolUseId: (raw.parent_tool_use_id as string) || null,
			content: convertAssistantContent(message),
			stopReason: (message?.stop_reason as StopReason) || null,
			usage: convertUsage(raw),
		} satisfies AssistantMessage;
	}

	// Fallback
	return {
		...base,
		type: 'assistant',
		parentToolUseId: null,
		content: [{ type: 'text', text: '' }],
		stopReason: null,
		usage: null,
	} satisfies AssistantMessage;
}

// ── Content extraction helpers ──────────────────────────────

function extractText(message: Record<string, unknown> | undefined): string {
	if (!message) return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: Record<string, unknown>) => b.type === 'text')
			.map((b: Record<string, unknown>) => (b.text as string) || '')
			.join('\n');
	}
	return '';
}

function convertUserContent(message: Record<string, unknown> | undefined): UserContentBlock[] {
	if (!message) return [{ type: 'text', text: '' }];
	const rawContent = message.content;
	if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }];
	if (!Array.isArray(rawContent)) return [{ type: 'text', text: '' }];

	return rawContent.map((block: Record<string, unknown>): UserContentBlock => {
		if (block.type === 'tool_result') {
			return {
				type: 'tool_result',
				toolUseId: (block.tool_use_id as string) || '',
				content: typeof block.content === 'string'
					? block.content
					: JSON.stringify(block.content ?? ''),
				isError: (block.is_error as boolean) || false,
			} satisfies ToolResult;
		}
		if (block.type === 'image') {
			const source = block.source as Record<string, unknown> | undefined;
			return {
				type: 'image',
				mediaType: (source?.media_type as string) || 'image/png',
				data: (source?.data as string) || '',
			};
		}
		return { type: 'text', text: (block.text as string) || '' } satisfies TextBlock;
	});
}

function convertAssistantContent(message: Record<string, unknown> | undefined): AssistantContentBlock[] {
	if (!message) return [{ type: 'text', text: '' }];
	const rawContent = message.content;
	if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }];
	if (!Array.isArray(rawContent)) return [{ type: 'text', text: '' }];

	return rawContent.map((block: Record<string, unknown>): AssistantContentBlock => {
		if (block.type === 'tool_use') {
			return {
				type: 'tool_use',
				id: (block.id as string) || '',
				name: (block.name as string) || '',
				input: (block.input as Record<string, unknown>) || {},
			} as ToolUseBlock;
		}
		return { type: 'text', text: (block.text as string) || '' } satisfies TextBlock;
	});
}

function convertUsage(raw: Record<string, unknown>): TokenUsage | null {
	const usage = (raw.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
	if (!usage) return null;
	return {
		inputTokens: (usage.input_tokens as number) || 0,
		outputTokens: (usage.output_tokens as number) || 0,
		cacheCreationInputTokens: (usage.cache_creation_input_tokens as number) || 0,
		cacheReadInputTokens: (usage.cache_read_input_tokens as number) || 0,
	};
}
