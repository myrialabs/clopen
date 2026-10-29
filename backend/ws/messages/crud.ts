/**
 * Messages CRUD Operations
 *
 * HTTP endpoints for message management:
 * - List messages (with optional include_all for history view)
 * - Get message by ID
 * - Resolve which of a session's message ids are saved
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
	}, async ({ data }) => {
		requireSessionAccess(data.session_id);
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
	}, async ({ data }) => {
		const message = requireMessageAccess(data.messageId);
		return loadMessage(message);
	})

	// Which of these ids are saved messages of the session, and what they hold.
	// A sender checks the bubbles it is still showing optimistically: a send
	// whose echo never arrived (socket dropped, stopped early) may still have
	// been saved, or may never have reached the server at all.
	.http('messages:resolve', {
		data: t.Object({
			session_id: t.String({ minLength: 1 }),
			ids: t.Array(t.String({ minLength: 1 }), { maxItems: 100 })
		}),
		response: t.Array(t.Any())
	}, async ({ data }) => {
		requireSessionAccess(data.session_id);
		const found: ReturnType<typeof loadMessage>[] = [];
		for (const id of new Set(data.ids)) {
			const row = messageQueries.getById(id);
			if (row && row.session_id === data.session_id) found.push(loadMessage(row));
		}
		return found;
	})

	// Get full (untrimmed) sub-agent messages nested under a message.
	// Used by the Debug modal to show complete data despite the wire trimming
	// sub-agent noise from the normal chat payload.
	.http('messages:get-subagents', {
		data: t.Object({
			messageId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Any())
	}, async ({ data }) => {
		requireMessageAccess(data.messageId);
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
	}, async ({ data }) => {
		// Check if message exists first
		requireMessageAccess(data.messageId);

		// Delete the message
		messageQueries.delete(data.messageId);

		return {
			message: 'Message deleted successfully'
		};
	});
