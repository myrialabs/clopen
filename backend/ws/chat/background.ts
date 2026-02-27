/**
 * Chat Background Streaming
 *
 * Handles background chat streaming that continues even when browser is closed.
 * Provides HTTP endpoints for stream management and polling.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { streamManager } from '../../lib/chat/stream-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/lib/utils/ws';

export const backgroundHandler = createRouter()
	// Start background stream (fire-and-forget)
	.on('chat:background-start', {
		data: t.Object({
			prompt: t.Any(), // SDKUserMessage object
			chatSessionId: t.String(),
			projectPath: t.Optional(t.String()),
			messages: t.Optional(t.Array(t.Any())),
			model: t.Optional(t.String()),
			temperature: t.Optional(t.Number()),
			senderId: t.Optional(t.String()),
			senderName: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		try {
			debug.log('chat', 'WS chat:background-start received:', {
				chatSessionId: data.chatSessionId,
				projectId,
				messagesCount: data.messages?.length || 0
			});

			// Start background stream
			const streamId = await streamManager.startStream({
				projectPath: data.projectPath || '',
				projectId,
				prompt: data.prompt,
				messages: data.messages || [],
				chatSessionId: data.chatSessionId,
				model: data.model,
				temperature: data.temperature,
				senderId: data.senderId,
				senderName: data.senderName
			});

			debug.log('chat', 'Background stream started with ID:', streamId);

			// Broadcast to all users in project (collaborative)
			ws.emit.project(projectId, 'chat:background-started', {
				streamId,
				status: 'started'
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			debug.error('chat', 'WS chat:background-start error:', errorMessage);

			ws.emit.project(projectId, 'chat:background-error', {
				error: errorMessage
			});
		}
	})

	// Get background stream state (HTTP pattern for request-response)
	.http('chat:background-state', {
		data: t.Object({
			streamId: t.Optional(t.String()),
			chatSessionId: t.Optional(t.String()),
			offset: t.Optional(t.Number())
		}),
		response: t.Object({
			streamId: t.String(),
			status: t.Union([
				t.Literal('active'),
				t.Literal('completed'),
				t.Literal('error'),
				t.Literal('cancelled')
			]),
			processId: t.String(),
			messages: t.Array(t.Any()),
			currentPartialText: t.Optional(t.String()),
			error: t.Optional(t.String()),
			startedAt: t.String(),
			completedAt: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		// Find stream by ID or session
		let streamState;
		if (data.streamId) {
			streamState = streamManager.getStream(data.streamId);
		} else if (data.chatSessionId) {
			streamState = streamManager.getSessionStream(data.chatSessionId, projectId);
		}

		// Return a "not found" response instead of throwing
		// This happens normally when a stream was cancelled/completed and cleaned up
		if (!streamState) {
			return {
				streamId: data.streamId || data.chatSessionId || '',
				status: 'completed' as const,
				processId: '',
				messages: [],
				currentPartialText: undefined,
				error: undefined,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString()
			};
		}

		// Get messages from offset
		const offset = data.offset || 0;
		const messages = streamState.messages.slice(offset);

		return {
			streamId: streamState.streamId,
			status: streamState.status,
			processId: streamState.processId,
			messages,
			currentPartialText: streamState.currentPartialText,
			error: streamState.error,
			startedAt: streamState.startedAt.toISOString(),
			completedAt: streamState.completedAt?.toISOString()
		};
	})

	// Get background stream messages (HTTP pattern for request-response)
	.http('chat:background-messages', {
		data: t.Object({
			streamId: t.Optional(t.String()),
			chatSessionId: t.Optional(t.String()),
			offset: t.Optional(t.Number())
		}),
		response: t.Object({
			messages: t.Array(t.Any()),
			hasMore: t.Boolean(),
			status: t.String()
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		// Find stream by ID or session
		let streamState;
		if (data.streamId) {
			streamState = streamManager.getStream(data.streamId);
		} else if (data.chatSessionId) {
			streamState = streamManager.getSessionStream(data.chatSessionId, projectId);
		}

		if (!streamState) {
			throw new Error('Stream not found');
		}

		// Get messages from offset
		const offset = data.offset || 0;
		const messages = streamState.messages.slice(offset);
		const hasMore = streamState.status === 'active';

		return {
			messages,
			hasMore,
			status: streamState.status
		};
	})

	// Cancel background stream (HTTP pattern for request-response)
	.http('chat:background-cancel', {
		data: t.Object({
			streamId: t.String()
		}),
		response: t.Object({
			status: t.Literal('cancelled')
		})
	}, async ({ data }) => {
		const cancelled = await streamManager.cancelStream(data.streamId);

		if (!cancelled) {
			throw new Error('Stream not found or already completed');
		}

		return {
			status: 'cancelled' as const
		};
	})

	// Event declarations (only for fire-and-forget actions)
	.emit('chat:background-started', t.Object({
		streamId: t.String(),
		status: t.Literal('started')
	}))

	.emit('chat:background-error', t.Object({
		error: t.String()
	}));
