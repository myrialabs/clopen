/**
 * UnifiedMessage — the discriminated union of all persistent message types.
 *
 * All messages extend MessageBase which carries identity, session,
 * and context fields at the root level.
 */

import type { TokenUsage, StopReason } from './common';
import type { ToolUseBlock, ToolResult } from './tool';

// ============================================================
// Message Base
// ============================================================

/** Common fields present on every message */
export interface MessageBase {
	id: string;
	sessionId: string;
	createdAt: string;
	parentMessageId: string | null;
	senderId: string | null;
	senderName: string | null;
	model: string | null;
	engine: string | null;
}

// ============================================================
// Content Blocks
// ============================================================

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ImageBlock {
	type: 'image';
	mediaType: string;
	data: string;
}

export interface DocumentBlock {
	type: 'document';
	mediaType: string;
	data: string;
	title: string | null;
}

export type UserContentBlock =
	| TextBlock
	| ToolResult
	| ImageBlock
	| DocumentBlock;

export type AssistantContentBlock =
	| TextBlock
	| ToolUseBlock;

// ============================================================
// Message Types
// ============================================================

/**
 * User-submitted message.
 * Contains text, file attachments, or tool execution results.
 */
export interface UserMessage extends MessageBase {
	type: 'user';
	parentToolUseId: string | null;
	content: UserContentBlock[];
	synthetic: boolean;
}

/**
 * AI assistant response.
 * Contains text and/or tool invocations.
 */
export interface AssistantMessage extends MessageBase {
	type: 'assistant';
	parentToolUseId: string | null;
	content: AssistantContentBlock[];
	stopReason: StopReason | null;
	usage: TokenUsage | null;
}

/**
 * Reasoning/thinking content from the model.
 * Displayed as a separate collapsible bubble in the UI.
 */
export interface ReasoningMessage extends MessageBase {
	type: 'reasoning';
	text: string;
}

/**
 * Context compaction boundary marker.
 * Rendered as a visual separator when the engine compacts context.
 */
export interface CompactBoundaryMessage extends MessageBase {
	type: 'compact_boundary';
	trigger: 'manual' | 'auto';
	preTokens: number;
}

// ============================================================
// UnifiedMessage
// ============================================================

/**
 * Discriminated union of all persistent message types.
 *
 * This is the canonical format for DB storage, WebSocket transport,
 * and frontend rendering. Engine adapters convert SDK-specific
 * formats to this type.
 */
export type UnifiedMessage =
	| UserMessage
	| AssistantMessage
	| ReasoningMessage
	| CompactBoundaryMessage;
