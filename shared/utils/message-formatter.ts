/**
 * Message Formatter - Single source of truth for SDK message formatting
 *
 * Converts raw data → SDKMessageFormatter with metadata.
 * Used by ALL paths that return messages to the frontend:
 * - Backend: message-queries.ts, messages/crud.ts
 * - Frontend: chat.service.ts (stream transport → metadata)
 *
 * This ensures stream response and DB response produce identical structure.
 */

import type { DatabaseMessage, SDKMessageFormatter } from '$shared/types/database/schema';
import type { EngineSDKMessage } from '$shared/types/messaging';

/**
 * Format a DatabaseMessage into SDKMessageFormatter
 * Parses sdk_message JSON and attaches system metadata
 */
export function formatDatabaseMessage(
	msg: DatabaseMessage,
	overrides?: {
		sender_id?: string | null;
		sender_name?: string | null;
	}
): SDKMessageFormatter {
	const sdkMessage = JSON.parse(msg.sdk_message) as EngineSDKMessage;

	return {
		...sdkMessage,
		metadata: {
			...buildMetadataFromDb(msg, overrides),
			...(sdkMessage.metadata?.reasoning && { reasoning: true }),
		}
	};
}

/**
 * Build metadata object from DatabaseMessage fields
 * This is the SINGLE definition of what metadata contains from DB
 */
export function buildMetadataFromDb(
	msg: DatabaseMessage,
	overrides?: {
		sender_id?: string | null;
		sender_name?: string | null;
	}
): NonNullable<SDKMessageFormatter['metadata']> {
	return {
		message_id: msg.id,
		created_at: msg.timestamp,
		parent_message_id: msg.parent_message_id || null,
		sender_id: overrides?.sender_id ?? msg.sender_id ?? null,
		sender_name: overrides?.sender_name ?? msg.sender_name ?? null,
	};
}

/**
 * Build metadata from stream transport fields (used by frontend during stream)
 * Produces identical structure as buildMetadataFromDb
 */
export function buildMetadataFromTransport(transport: {
	message_id?: string;
	timestamp?: string;
	parent_message_id?: string | null;
	sender_id?: string | null;
	sender_name?: string | null;
	engine?: string;
	reasoning?: boolean;
}): NonNullable<SDKMessageFormatter['metadata']> {
	return {
		message_id: transport.message_id || undefined,
		created_at: transport.timestamp || new Date().toISOString(),
		parent_message_id: transport.parent_message_id ?? null,
		sender_id: transport.sender_id ?? null,
		sender_name: transport.sender_name ?? null,
		engine: transport.engine,
		...(transport.reasoning && { reasoning: true }),
	};
}
