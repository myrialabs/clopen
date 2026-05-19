/**
 * Engine output and streaming event types.
 *
 * Defines all events yielded by engine adapters during query execution.
 * The stream-manager routes each event type:
 * - Messages → save to DB + emit to WebSocket
 * - Stream events → forward to frontend for live typing
 * - System/result events → extract metadata, emit notifications
 */

import type { TokenUsage } from './common';
import type {
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	CompactBoundaryMessage,
	UnifiedMessage,
	MessageEngine,
	MessageSender,
} from './message';

// ============================================================
// Stream Events (transient, not persisted)
// ============================================================

export interface TextDeltaEvent {
	type: 'stream_event';
	event: 'delta';
	sessionId: string;
	text: string;
	reasoning: boolean;
}

export interface StreamLifecycleEvent {
	type: 'stream_event';
	event: 'start' | 'stop';
	sessionId: string;
	reasoning: boolean;
}

export type StreamEvent =
	| TextDeltaEvent
	| StreamLifecycleEvent;

// ============================================================
// Result Events (transient, completion info)
// ============================================================

export interface SuccessResultEvent {
	type: 'result';
	subtype: 'success';
	sessionId: string;
	numTurns: number;
	totalCostUsd: number;
	usage: TokenUsage;
	stopReason: string | null;
}

export interface ErrorResultEvent {
	type: 'result';
	subtype: 'error_max_turns' | 'error_during_execution' | 'error_max_budget';
	sessionId: string;
	errors: string[];
}

export type ResultEvent =
	| SuccessResultEvent
	| ErrorResultEvent;

// ============================================================
// System Events (transient)
// ============================================================

export interface SystemInitEvent {
	type: 'system_init';
	sessionId: string;
	model: string;
	engine: string;
	tools: string[];
	mcpServers: McpServerStatus[];
}

export interface McpServerStatus {
	name: string;
	status: 'connected' | 'disconnected' | 'error';
}

export type RateLimitType =
	| 'five_hour'
	| 'seven_day'
	| 'seven_day_opus'
	| 'seven_day_sonnet'
	| 'overage';

export interface RateLimitEvent {
	type: 'rate_limit';
	sessionId: string;
	status: 'rejected' | 'allowed_warning';
	utilization: number;
	resetsAt: number | null;
	rateLimitType: RateLimitType | null;
}

// ============================================================
// Engine Output
// ============================================================

/**
 * Union of all events yielded by engine adapters via AsyncGenerator.
 * Stream-manager discriminates on `type` to route each event.
 */
export type EngineOutput =
	| UserMessage
	| AssistantMessage
	| ReasoningMessage
	| CompactBoundaryMessage
	| StreamEvent
	| ResultEvent
	| SystemInitEvent
	| RateLimitEvent;

// ============================================================
// Stream Transport (WebSocket layer)
// ============================================================

export type StreamEventType =
	| 'connection'
	| 'message'
	| 'partial'
	| 'notification'
	| 'complete'
	| 'error'
	| 'cancelled';

export type StreamStatus = 'active' | 'completed' | 'error' | 'cancelled';

export interface StreamNotification {
	type: 'info' | 'warning' | 'error';
	title: string;
	message: string;
}

export interface PartialMessageData {
	processId: string;
	eventType: 'start' | 'update' | 'end';
	partialText: string;
	deltaText: string;
	reasoning: boolean;
	timestamp: string;
}

export interface MessageTransportData {
	processId: string;
	message: UnifiedMessage;
	usage?: TokenUsage;
}

export interface StreamRequest {
	projectPath: string;
	projectId: string;
	chatSessionId: string;
	prompt: UserMessage;
	engine: MessageEngine;
	sender: MessageSender;
}
