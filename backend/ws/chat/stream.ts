/**
 * Chat Streaming Events (Optimized)
 *
 * High-performance event-driven chat streaming with:
 * - Zero polling (pure EventEmitter push)
 * - Automatic cleanup on disconnect
 * - Support for stream cancellation
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { streamManager, type StreamEvent } from '../../lib/chat/stream-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/lib/utils/ws';
import { broadcastPresence } from '../projects/status';
import { sessionQueries } from '../../lib/database/queries';

// ============================================================================
// Global stream lifecycle handler (module-level, not per-connection)
//
// This fires for ALL stream completions, even when no per-connection subscriber
// exists (e.g., after browser refresh when user is on a different project).
// Ensures cross-project notifications (presence update, sound, push) always work.
// ============================================================================
streamManager.on('stream:lifecycle', (event: { status: string; streamId: string; projectId?: string; chatSessionId?: string; timestamp: string }) => {
	const { status, projectId, chatSessionId, timestamp } = event;
	if (!projectId) return;

	debug.log('chat', `Stream lifecycle: ${status} for project ${projectId} session ${chatSessionId}`);

	// Notify all project members (cross-project notification for sound + push)
	ws.emit.projectMembers(projectId, 'chat:stream-finished', {
		projectId,
		chatSessionId: chatSessionId || '',
		status: status as 'completed' | 'error' | 'cancelled',
		timestamp
	});

	// Broadcast updated presence (status indicators for all projects)
	broadcastPresence().catch(() => {});
});

// In-memory store for latest chat input state per chat session (keyed by chatSessionId)
const chatSessionInputState = new Map<string, { text: string; senderId: string; attachments?: any[] }>();

// In-memory store for edit mode state per chat session (keyed by chatSessionId)
const chatSessionEditMode = new Map<string, { isEditing: boolean; messageId: string | null; messageTimestamp: string | null }>();

// In-memory store for model state per chat session (keyed by chatSessionId)
const chatSessionModelState = new Map<string, { engine: string; model: string; senderId: string }>();

// In-memory store for account state per chat session (keyed by chatSessionId)
const chatSessionAccountState = new Map<string, { claudeAccountId: number | null; senderId: string }>();

export const streamHandler = createRouter()
	// Join a chat session room (subscribe to chat events for this session)
	.on('chat:join-session', {
		data: t.Object({
			chatSessionId: t.String()
		})
	}, ({ data, conn }) => {
		// Leave all previous chat sessions first (1 session at a time per connection)
		ws.leaveAllChatSessions(conn);
		ws.joinChatSession(conn, data.chatSessionId);
		// Broadcast presence so all clients see updated chatSessionUsers
		broadcastPresence().catch(() => {});
	})

	// Leave a chat session room
	.on('chat:leave-session', {
		data: t.Object({
			chatSessionId: t.String()
		})
	}, ({ data, conn }) => {
		ws.leaveChatSession(conn, data.chatSessionId);
		// Broadcast presence so all clients see updated chatSessionUsers
		broadcastPresence().catch(() => {});
	})

	// Start chat stream
	.on('chat:stream', {
		data: t.Object({
			sessionId: t.String(),
			chatSessionId: t.String(),
			projectPath: t.String(),
			prompt: t.Any(), // SDKUserMessage object
			messages: t.Optional(t.Array(t.Any())),
			engine: t.Optional(t.Union([t.Literal('claude-code'), t.Literal('opencode')])),
			model: t.Optional(t.String()),
			temperature: t.Optional(t.Number()),
			senderId: t.Optional(t.String()),
			senderName: t.Optional(t.String()),
			claudeAccountId: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		try {
			debug.log('chat', 'WS chat:stream received:', {
				chatSessionId: data.chatSessionId,
				projectId,
				messagesCount: data.messages?.length || 0
			});

			// Start background stream
			const streamId = await streamManager.startStream({
				projectPath: data.projectPath,
				projectId,
				prompt: data.prompt,
				messages: data.messages || [],
				chatSessionId: data.chatSessionId,
				engine: data.engine || 'claude-code',
				model: data.model,
				temperature: data.temperature,
				senderId: data.senderId,
				senderName: data.senderName,
				claudeAccountId: data.claudeAccountId
			});

			debug.log('chat', 'Stream started with ID:', streamId);

			// Emit connection event to chat session room and broadcast presence immediately
			// (the connection event from startStream() fires before subscription, so we emit it manually)
			const stream = streamManager.getStream(streamId);
			if (stream) {
				ws.emit.chatSession(data.chatSessionId, 'chat:connection', {
					processId: stream.processId,
					timestamp: stream.startedAt.toISOString(),
					seq: 1
				});
				// User message is broadcast by stream-manager via event subscription below
				// (includes resume, sender info, and saved message ID)
			}
			broadcastPresence().catch(() => {});

			// Subscribe to stream events (event-driven, no polling)
			// Use ws.emit.chatSession() for session-scoped chat events
			// Only users who joined this chat session room receive events
			const chatSessionId = data.chatSessionId;
			const handleStreamEvent = (event: StreamEvent) => {
				try {
					switch (event.type) {
						case 'connection':
							ws.emit.chatSession(chatSessionId, 'chat:connection', {
								processId: event.data.processId,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							broadcastPresence().catch(() => {});
							break;

						case 'message':
							ws.emit.chatSession(chatSessionId, 'chat:message', {
								processId: event.processId,
								message: event.data.message,
								usage: event.data.usage,
								timestamp: event.data.timestamp,
								message_id: event.data.message_id,
								parent_message_id: event.data.parent_message_id,
								sender_id: event.data.sender_id,
								sender_name: event.data.sender_name,
								engine: event.data.engine,
								seq: event.seq
							});
							break;

						case 'partial':
							ws.emit.chatSession(chatSessionId, 'chat:partial', {
								processId: event.processId,
								eventType: event.data.eventType as any,
								partialText: event.data.partialText || '',
								deltaText: event.data.deltaText || '',
								...(event.data.reasoning && { reasoning: true }),
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							break;

						case 'notification':
							ws.emit.chatSession(chatSessionId, 'chat:notification', {
								notification: event.data.notification,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							break;

						case 'complete':
							ws.emit.chatSession(chatSessionId, 'chat:complete', {
								processId: event.processId,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications (stream-finished, presence) are handled
							// by the global stream:lifecycle listener at the module level.
							unsubscribe();
							break;

						case 'error':
							ws.emit.chatSession(chatSessionId, 'chat:error', {
								processId: event.processId,
								error: event.data.error,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications handled by stream:lifecycle listener
							unsubscribe();
							break;

						case 'cancelled':
							ws.emit.chatSession(chatSessionId, 'chat:error', {
								processId: event.processId,
								error: 'Stream cancelled',
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications handled by stream:lifecycle listener
							unsubscribe();
							break;
					}
				} catch (err) {
					debug.error('chat', 'Error handling stream event:', err);
					unsubscribe();
				}
			};

			// Subscribe to stream events
			const unsubscribe = streamManager.subscribeToStream(streamId, handleStreamEvent);

			// Register cleanup with WSServer (called automatically on connection close)
			ws.addCleanup(conn, unsubscribe);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			debug.error('chat', 'WS chat:stream error:', errorMessage);

			ws.emit.chatSession(data.chatSessionId, 'chat:error', {
				processId: crypto.randomUUID(),
				error: errorMessage,
				timestamp: new Date().toISOString()
			});
		}
	})

	// Reconnect to an active stream (after browser refresh / project switch)
	// Re-subscribes the new connection to receive live stream events
	.on('chat:reconnect', {
		data: t.Object({
			chatSessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		try {
			const chatSessionId = data.chatSessionId;
			const streamState = streamManager.getSessionStream(chatSessionId, projectId);
			if (!streamState || streamState.status !== 'active') {
				// No active stream - nothing to reconnect
				return;
			}

			debug.log('chat', 'Reconnecting to active stream:', streamState.streamId);

			// Subscribe this connection to the stream's events (session-scoped)
			const handleStreamEvent = (event: StreamEvent) => {
				try {
					switch (event.type) {
						case 'connection':
							ws.emit.chatSession(chatSessionId, 'chat:connection', {
								processId: event.data.processId,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							break;

						case 'message':
							ws.emit.chatSession(chatSessionId, 'chat:message', {
								processId: event.processId,
								message: event.data.message,
								usage: event.data.usage,
								timestamp: event.data.timestamp,
								message_id: event.data.message_id,
								parent_message_id: event.data.parent_message_id,
								sender_id: event.data.sender_id,
								sender_name: event.data.sender_name,
								engine: event.data.engine,
								seq: event.seq
							});
							break;

						case 'partial':
							ws.emit.chatSession(chatSessionId, 'chat:partial', {
								processId: event.processId,
								eventType: event.data.eventType as any,
								partialText: event.data.partialText || '',
								deltaText: event.data.deltaText || '',
								...(event.data.reasoning && { reasoning: true }),
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							break;

						case 'notification':
							ws.emit.chatSession(chatSessionId, 'chat:notification', {
								notification: event.data.notification,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							break;

						case 'complete':
							ws.emit.chatSession(chatSessionId, 'chat:complete', {
								processId: event.processId,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications handled by stream:lifecycle listener
							unsubscribe();
							break;

						case 'error':
							ws.emit.chatSession(chatSessionId, 'chat:error', {
								processId: event.processId,
								error: event.data.error,
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications handled by stream:lifecycle listener
							unsubscribe();
							break;

						case 'cancelled':
							ws.emit.chatSession(chatSessionId, 'chat:error', {
								processId: event.processId,
								error: 'Stream cancelled',
								timestamp: event.data.timestamp,
								seq: event.seq
							});
							// Cross-project notifications handled by stream:lifecycle listener
							unsubscribe();
							break;
					}
				} catch (err) {
					debug.error('chat', 'Error handling reconnected stream event:', err);
					unsubscribe();
				}
			};

			const unsubscribe = streamManager.subscribeToStream(streamState.streamId, handleStreamEvent);
			ws.addCleanup(conn, unsubscribe);

			// Send current state snapshot to chat session room so frontend can catch up
			ws.emit.chatSession(chatSessionId, 'chat:connection', {
				processId: streamState.processId,
				timestamp: streamState.startedAt.toISOString(),
				seq: streamState.eventSeq
			});

		} catch (error) {
			debug.error('chat', 'Error reconnecting to stream:', error);
		}
	})

	// Cancel stream
	.on('chat:cancel', {
		data: t.Object({
			sessionId: t.String(),
			chatSessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const chatSessionId = data.chatSessionId;

		try {
			// Find stream by session
			const streamState = streamManager.getSessionStream(chatSessionId, projectId);
			if (!streamState) {
				// Stream not found - could already be completed/cleaned up
				// Send cancellation to chat session room so frontend stops loading
				ws.emit.chatSession(chatSessionId, 'chat:cancelled', {
					status: 'cancelled',
					processId: ''
				});
				broadcastPresence().catch(() => {});
				return;
			}

			const cancelled = await streamManager.cancelStream(streamState.streamId);
			// Always send cancelled to chat session room to clear UI
			ws.emit.chatSession(chatSessionId, 'chat:cancelled', {
				status: 'cancelled',
				processId: streamState.processId
			});
			// Always broadcast presence after cancel attempt to update all clients
			broadcastPresence().catch(() => {});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			ws.emit.chatSession(chatSessionId, 'chat:error', {
				processId: '',
				error: errorMessage,
				timestamp: new Date().toISOString()
			});
			broadcastPresence().catch(() => {});
		}
	})

	// Collaborative edit mode - broadcast and store edit mode state per chat session
	.on('chat:edit-mode', {
		data: t.Object({
			senderId: t.String(),
			chatSessionId: t.String(),
			isEditing: t.Boolean(),
			messageId: t.Union([t.String(), t.Null()]),
			messageTimestamp: t.Union([t.String(), t.Null()])
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId;

		// Store on server for late joiners / refresh (keyed by chatSessionId)
		if (data.isEditing && data.messageId) {
			chatSessionEditMode.set(chatSessionId, {
				isEditing: true,
				messageId: data.messageId,
				messageTimestamp: data.messageTimestamp
			});
		} else {
			chatSessionEditMode.delete(chatSessionId);
		}

		ws.emit.chatSession(chatSessionId, 'chat:edit-mode', {
			senderId: data.senderId,
			isEditing: data.isEditing,
			messageId: data.messageId,
			messageTimestamp: data.messageTimestamp
		});
	})

	// Get current edit mode state for a chat session (for refresh / late joiners)
	.http('chat:get-edit-mode', {
		data: t.Object({
			chatSessionId: t.Optional(t.String())
		}),
		response: t.Object({
			isEditing: t.Boolean(),
			messageId: t.Union([t.String(), t.Null()]),
			messageTimestamp: t.Union([t.String(), t.Null()])
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId || '';
		const editState = chatSessionEditMode.get(chatSessionId);
		return editState || { isEditing: false, messageId: null, messageTimestamp: null };
	})

	// Collaborative input sync - broadcast typing/attachments to other users in the same chat session
	.on('chat:input-sync', {
		data: t.Object({
			text: t.String(),
			senderId: t.String(),
			chatSessionId: t.String(),
			attachments: t.Optional(t.Array(t.Object({
				id: t.String(),
				fileName: t.String(),
				type: t.String(),
				mediaType: t.String(),
				base64: t.String()
			})))
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId;

		// Store latest input state on server for late-joining users (keyed by chatSessionId)
		chatSessionInputState.set(chatSessionId, {
			text: data.text,
			senderId: data.senderId,
			attachments: data.attachments
		});

		ws.emit.chatSession(chatSessionId, 'chat:input-sync', {
			text: data.text,
			senderId: data.senderId,
			attachments: data.attachments
		});
	})

	// Get latest input state for a chat session (for users switching sessions)
	.http('chat:get-input-state', {
		data: t.Object({
			chatSessionId: t.Optional(t.String())
		}),
		response: t.Object({
			text: t.String(),
			senderId: t.String(),
			attachments: t.Optional(t.Array(t.Object({
				id: t.String(),
				fileName: t.String(),
				type: t.String(),
				mediaType: t.String(),
				base64: t.String()
			})))
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId || '';
		const state = chatSessionInputState.get(chatSessionId);
		return state || { text: '', senderId: '' };
	})

	// Collaborative model sync - broadcast model changes to other users in the same chat session
	.on('chat:model-sync', {
		data: t.Object({
			senderId: t.String(),
			chatSessionId: t.String(),
			engine: t.String(),
			model: t.String()
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId;

		// Store latest model state on server for late joiners / refresh
		chatSessionModelState.set(chatSessionId, {
			engine: data.engine,
			model: data.model,
			senderId: data.senderId
		});

		// Persist engine/model to the session record in the database
		// so refreshes and late joiners get the correct model
		try {
			sessionQueries.updateEngineModel(chatSessionId, data.engine, data.model);
		} catch (err) {
			debug.error('chat', 'Failed to persist model sync to DB:', err);
		}

		// Broadcast to all users in the same chat session
		ws.emit.chatSession(chatSessionId, 'chat:model-sync', {
			senderId: data.senderId,
			engine: data.engine,
			model: data.model
		});
	})

	// Get current model state for a chat session (for refresh / late joiners)
	.http('chat:get-model-state', {
		data: t.Object({
			chatSessionId: t.Optional(t.String())
		}),
		response: t.Object({
			engine: t.String(),
			model: t.String(),
			senderId: t.String()
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId || '';
		const state = chatSessionModelState.get(chatSessionId);
		return state || { engine: '', model: '', senderId: '' };
	})

	// Collaborative account sync - broadcast account changes to other users in the same chat session
	.on('chat:account-sync', {
		data: t.Object({
			senderId: t.String(),
			chatSessionId: t.String(),
			claudeAccountId: t.Union([t.Number(), t.Null()])
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId;

		// Store latest account state on server for late joiners / refresh
		chatSessionAccountState.set(chatSessionId, {
			claudeAccountId: data.claudeAccountId,
			senderId: data.senderId
		});

		// Persist claude_account_id to the session record in the database
		try {
			sessionQueries.updateClaudeAccountId(chatSessionId, data.claudeAccountId);
		} catch (err) {
			debug.error('chat', 'Failed to persist account sync to DB:', err);
		}

		// Broadcast to all users in the same chat session
		ws.emit.chatSession(chatSessionId, 'chat:account-sync', {
			senderId: data.senderId,
			claudeAccountId: data.claudeAccountId
		});
	})

	// Get current account state for a chat session (for refresh / late joiners)
	.http('chat:get-account-state', {
		data: t.Object({
			chatSessionId: t.Optional(t.String())
		}),
		response: t.Object({
			claudeAccountId: t.Union([t.Number(), t.Null()]),
			senderId: t.String()
		})
	}, ({ data }) => {
		const chatSessionId = data.chatSessionId || '';
		const state = chatSessionAccountState.get(chatSessionId);
		return state || { claudeAccountId: null, senderId: '' };
	})

	// Event declarations
	.emit('chat:edit-mode', t.Object({
		senderId: t.String(),
		isEditing: t.Boolean(),
		messageId: t.Union([t.String(), t.Null()]),
		messageTimestamp: t.Union([t.String(), t.Null()])
	}))

	.emit('chat:input-sync', t.Object({
		text: t.String(),
		senderId: t.String(),
		attachments: t.Optional(t.Array(t.Object({
			id: t.String(),
			fileName: t.String(),
			type: t.String(),
			mediaType: t.String(),
			base64: t.String()
		}))),
		chatSessionId: t.Optional(t.String())
	}))

	.emit('chat:model-sync', t.Object({
		senderId: t.String(),
		engine: t.String(),
		model: t.String()
	}))

	.emit('chat:account-sync', t.Object({
		senderId: t.String(),
		claudeAccountId: t.Union([t.Number(), t.Null()])
	}))

	.emit('chat:connection', t.Object({
		processId: t.String(),
		timestamp: t.String(),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:message', t.Object({
		processId: t.String(),
		message: t.Any(), // SDKMessage
		usage: t.Optional(t.Any()),
		timestamp: t.String(),
		message_id: t.Optional(t.String()),
		parent_message_id: t.Optional(t.Union([t.String(), t.Null()])),
		sender_id: t.Optional(t.String()),
		sender_name: t.Optional(t.String()),
		engine: t.Optional(t.String()),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:partial', t.Object({
		processId: t.String(),
		eventType: t.Union([
			t.Literal('start'),
			t.Literal('update'),
			t.Literal('end')
		]),
		partialText: t.String(),
		deltaText: t.String(),
		reasoning: t.Optional(t.Boolean()),
		timestamp: t.String(),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:notification', t.Object({
		notification: t.Object({
			type: t.String(),
			title: t.String(),
			message: t.String(),
			icon: t.Optional(t.String())
		}),
		timestamp: t.String(),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:complete', t.Object({
		processId: t.String(),
		timestamp: t.String(),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:error', t.Object({
		processId: t.String(),
		error: t.String(),
		timestamp: t.String(),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:cancelled', t.Object({
		status: t.Literal('cancelled'),
		processId: t.Optional(t.String()),
		seq: t.Optional(t.Number())
	}))

	.emit('chat:messages-changed', t.Object({
		sessionId: t.String(),
		reason: t.String(),
		timestamp: t.String()
	}))

	.emit('chat:stream-finished', t.Object({
		projectId: t.String(),
		chatSessionId: t.String(),
		status: t.Union([t.Literal('completed'), t.Literal('error'), t.Literal('cancelled')]),
		timestamp: t.String()
	}));
