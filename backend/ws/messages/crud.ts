/**
 * Messages CRUD Operations
 *
 * HTTP endpoints for message management:
 * - List messages (with optional include_all for history view)
 * - Page through the active branch, its prompt index and older task tools
 * - Get message by ID
 * - Resolve which of a session's message ids are saved
 * - Delete message
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { messageQueries } from '../../database/queries';
import { loadMessage } from '$shared/utils/message-formatter';
import { requireMessageAccess, requireSessionAccess } from '../access';
import { getMessagePage, getPromptIndex, getTaskHistory } from '../../chat/message-pages';

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

	// One page of the active branch — the chat loads its latest turns and pages
	// back as the user scrolls up (see backend/chat/message-pages.ts).
	.http('messages:list-page', {
		data: t.Object({
			session_id: t.String({ minLength: 1 }),
			/** Return the page that ends just before this message; omit for the latest. */
			before_id: t.Optional(t.String()),
			/** Minimum page size; the page is extended back to the start of a turn. */
			limit: t.Optional(t.Number({ minimum: 1, maximum: 500 }))
		}),
		response: t.Object({
			messages: t.Array(t.Any()),
			hasMore: t.Boolean()
		})
	}, async ({ data }) => {
		requireSessionAccess(data.session_id);
		return getMessagePage(data.session_id, { beforeId: data.before_id, minCount: data.limit });
	})

	// Every user prompt on the active branch — the chat's navigation rail.
	.http('messages:list-prompts', {
		data: t.Object({
			session_id: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Object({
			messageId: t.String(),
			text: t.String(),
			createdAt: t.String()
		}))
	}, async ({ data }) => {
		requireSessionAccess(data.session_id);
		return getPromptIndex(data.session_id);
	})

	// Task-tool calls and results older than a message — the task widget replays
	// them together with the loaded messages.
	.http('messages:list-task-history', {
		data: t.Object({
			session_id: t.String({ minLength: 1 }),
			before_id: t.String({ minLength: 1 })
		}),
		response: t.Array(t.Any())
	}, async ({ data }) => {
		requireSessionAccess(data.session_id);
		return getTaskHistory(data.session_id, data.before_id);
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
