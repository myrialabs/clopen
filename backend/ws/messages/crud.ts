/**
 * Messages CRUD Operations
 *
 * HTTP endpoints for message management:
 * - List messages (with optional include_all for history view)
 * - Get message by ID
 * - Delete message
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries } from '../../database/queries';
import { loadMessage } from '$shared/utils/message-formatter';
import { requireMessageAccess, requireSessionAccess } from '../access';

export const crudHandler = createRouter()
	// List messages
	.http('messages:list', {
		data: t.Object({
			session_id: t.String({ minLength: 1 }),
			include_all: t.Optional(t.Boolean())
		}),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.session_id);
		if (data.include_all) {
			// Return all messages including those in other branches (for History view)
			const allMessages = messageQueries.getAllBySessionId(data.session_id);
			return allMessages.map(msg => loadMessage(msg));
		} else {
			// Default: return only messages in current HEAD path (for Chat view)
			return messageQueries.getBySessionId(data.session_id);
		}
	})

	// Get message by ID
	.http('messages:get', {
		data: t.Object({
			messageId: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const message = requireMessageAccess(conn, data.messageId);
		return loadMessage(message);
	})

	// Get full (untrimmed) sub-agent messages nested under a message.
	// Used by the Debug modal to show complete data despite the wire trimming
	// sub-agent noise from the normal chat payload.
	.http('messages:get-subagents', {
		data: t.Object({
			messageId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireMessageAccess(conn, data.messageId);
		return messageQueries.getSubAgentMessages(data.messageId);
	})

	// Delete message
	.http('messages:delete', {
		data: t.Object({
			messageId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		// Check if message exists first
		requireMessageAccess(conn, data.messageId);

		// Delete the message
		messageQueries.delete(data.messageId);

		return {
			message: 'Message deleted successfully'
		};
	});
