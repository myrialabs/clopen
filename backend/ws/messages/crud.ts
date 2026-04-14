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

export const crudHandler = createRouter()
	// List messages
	.http('messages:list', {
		data: t.Object({
			session_id: t.String({ minLength: 1 }),
			include_all: t.Optional(t.Boolean())
		}),
		response: t.Array(t.Any())
	}, async ({ data }) => {
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
		const message = messageQueries.getById(data.messageId);

		if (!message) {
			throw new Error('Message not found');
		}

		return loadMessage(message);
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
		const message = messageQueries.getById(data.messageId);
		if (!message) {
			throw new Error('Message not found');
		}

		// Delete the message
		messageQueries.delete(data.messageId);

		return {
			message: 'Message deleted successfully'
		};
	});
