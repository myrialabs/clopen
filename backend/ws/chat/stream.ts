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
import { streamManager, type StreamEvent } from '../../chat/stream-manager';
import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { broadcastPresence } from '../projects/status';
import { sessionQueries, messageQueries } from '../../database/queries';
import { requireSessionAccess } from '../access';

// ============================================================================
// Global stream lifecycle handler (module-level, not per-connection)
//
// This fires for ALL stream completions, even when no per-connection subscriber
// exists (e.g., after browser refresh when user is on a different project).
// Ensures cross-project notifications (presence update, sound, push) always work.
// ============================================================================
streamManager.on('stream:lifecycle', (event: { status: string; streamId: string; projectId?: string; chatSessionId?: string; timestamp: string; reason?: string }) => {
	const { status, projectId, chatSessionId, timestamp, reason } = event;
	if (!projectId) return;

	debug.log('chat', `Stream lifecycle: ${status} for project ${projectId} session ${chatSessionId}${reason ? ` (reason: ${reason})` : ''}`);

	// Mark any tool_use blocks that never got a tool_result as interrupted (persisted to DB)
	if (chatSessionId) {
		try {
			messageQueries.markInterruptedMessages(chatSessionId);
		} catch (err) {
			debug.error('chat', 'Failed to mark interrupted messages:', err);
		}
	}

	// Notify all project members (cross-project notification for sound + push)
	ws.emit.projectMembers(projectId, 'chat:stream-finished', {
		projectId,
		chatSessionId: chatSessionId || '',
		status: status as 'completed' | 'error' | 'cancelled',
		timestamp,
		reason
	});

	// Broadcast updated presence (status indicators for all projects)
	broadcastPresence().catch((err) => {
		debug.warn('chat', 'Presence broadcast error after stream lifecycle:', err);
	});
});

// Notify project members when a snapshot is captured (so the timeline modal can refresh stats)
streamManager.on('snapshot:captured', (event: { projectId: string; chatSessionId: string }) => {
	const { projectId, chatSessionId } = event;
	if (!projectId) return;

	ws.emit.projectMembers(projectId, 'snapshot:captured', { projectId, chatSessionId });
});

// In-memory store for latest chat input state per chat session (keyed by chatSessionId)
const chatSessionInputState = new Map<string, { text: string; senderId: string; attachments?: any[] }>();

// In-memory store for edit mode state per chat session (keyed by chatSessionId)
const chatSessionEditMode = new Map<string, { isEditing: boolean; messageId: string | null; messageTimestamp: string | null }>();

// In-memory store for model state per chat session (keyed by chatSessionId)
const chatSessionModelState = new Map<string, { engine: string; provider: string; modelId: string; modelName: string; senderId: string }>();

// In-memory store for account state per chat session (keyed by chatSessionId)
const chatSessionAccountState = new Map<string, { accountId: number | null; senderId: string }>();

export const streamHandler = createRouter()
	// Join a chat session room (subscribe to chat events for this session)
	.on('chat:join-session', {
		data: t.Object({
			chatSessionId: t.String()
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		// Leave all previous chat sessions first (1 session at a time per connection)
		ws.leaveAllChatSessions(conn);
		ws.joinChatSession(conn, data.chatSessionId);
		// Broadcast presence so all clients see updated chatSessionUsers
		broadcastPresence().catch((err) => {
			debug.warn('chat', 'Presence broadcast error after chat join-session:', err);
		});

		// Rehydrate rate-limit banners: replay every active snapshot to the
		// user so banners persist across page refresh AND across session /
		// project switches. Rate limits are scoped to account, not session,
		// so all active snapshots remain visible regardless of which session
		// the user is currently viewing.
		try {
			const userId = ws.getUserId(conn);
			const snapshots = streamManager.getAllActiveRateLimits();
			for (const snap of snapshots) {
				ws.emit.user(userId, 'chat:rate_limit', {
					chatSessionId: data.chatSessionId,
					engine: snap.engine,
					accountId: snap.accountId,
					status: snap.status,
					utilization: snap.utilization,
					resetsAt: snap.resetsAt,
					timestamp: snap.receivedAt
				});
			}
		} catch (err) {
			debug.warn('chat', 'Failed to rehydrate rate-limit on join-session:', err);
		}
	})

	// Dismiss the active rate-limit snapshot for a given engine/account so the
	// banner stops re-hydrating on subsequent join-session calls.
	.on('chat:rate-limit-dismiss', {
		data: t.Object({
			engine: t.String(),
			accountId: t.Number()
		})
	}, ({ data }) => {
		if (!data.accountId) return;
		streamManager.dismissRateLimit(data.engine as EngineType, data.accountId);
	})

	// Leave a chat session room
	.on('chat:leave-session', {
		data: t.Object({
			chatSessionId: t.String()
		})
	}, ({ data, conn }) => {
		ws.leaveChatSession(conn, data.chatSessionId);
		// Broadcast presence so all clients see updated chatSessionUsers
		broadcastPresence().catch((err) => {
			debug.warn('chat', 'Presence broadcast error after chat leave-session:', err);
		});
	})

	// Start chat stream
	.on('chat:stream', {
		data: t.Object({
			sessionId: t.String(),
			chatSessionId: t.String(),
			projectPath: t.String(),
			prompt: t.Any(), // UserMessage object
			engine: t.Object({
				type: t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen')]),
				provider: t.String(),
				model: t.Object({
					id: t.String(),
					name: t.String()
				}),
				account: t.Object({
					id: t.Number(),
					name: t.String()
				})
			}),
			sender: t.Object({
				id: t.String(),
				name: t.String()
			})
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const projectId = ws.getProjectId(conn);

		try {
			debug.log('chat', 'WS chat:stream received:', {
				chatSessionId: data.chatSessionId,
				projectId
			});

			// Start background stream
			const streamId = await streamManager.startStream({
				projectPath: data.projectPath,
				projectId,
				prompt: data.prompt,
				chatSessionId: data.chatSessionId,
				engine: data.engine,
				sender: data.sender
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
			broadcastPresence().catch((err) => {
				debug.warn('chat', 'Presence broadcast error on chat:stream start:', err);
			});

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
							broadcastPresence().catch((err) => {
								debug.warn('chat', 'Presence broadcast error on stream connection event:', err);
							});
							break;

						case 'message': {
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
							// Broadcast presence when waiting-input state may change
							// (AskUserQuestion tool_use arrives or tool_result clears it)
							const msgContent = Array.isArray(event.data.message?.message?.content) ? event.data.message.message.content : [];
							const askToolUse = msgContent.find((item: any) =>
								item.type === 'tool_use' && item.name === 'AskUserQuestion'
							);
							if (askToolUse || msgContent.some((item: any) => item.type === 'tool_result')) {
								broadcastPresence().catch((err) => {
									debug.warn('chat', 'Presence broadcast error on waiting-input state change:', err);
								});
							}
							// Notify all project members when AskUserQuestion arrives (sound + push)
							if (askToolUse && projectId) {
								ws.emit.projectMembers(projectId, 'chat:waiting-input', {
									projectId,
									chatSessionId,
									toolUseId: askToolUse.id,
									timestamp: event.data.timestamp || new Date().toISOString()
								});
							}
							break;
						}

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

						case 'rate_limit':
							ws.emit.chatSession(chatSessionId, 'chat:rate_limit', {
								chatSessionId: event.data.chatSessionId,
								engine: event.data.engine,
								accountId: event.data.accountId,
								status: event.data.status,
								utilization: event.data.utilization,
								resetsAt: event.data.resetsAt,
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
					// Log but do NOT unsubscribe — one bad event must not kill the
					// entire stream subscription. The bridge between StreamManager
					// and the WS room would be permanently broken, causing the UI
					// to stop receiving stream output while the WS stays connected.
					debug.error('chat', 'Error handling stream event:', err);
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
		requireSessionAccess(conn, data.chatSessionId);
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

						case 'message': {
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
							// Broadcast presence when waiting-input state may change
							const reconnMsgContent = Array.isArray(event.data.message?.message?.content) ? event.data.message.message.content : [];
							const reconnAskToolUse = reconnMsgContent.find((item: any) =>
								item.type === 'tool_use' && item.name === 'AskUserQuestion'
							);
							if (reconnAskToolUse || reconnMsgContent.some((item: any) => item.type === 'tool_result')) {
								broadcastPresence().catch((err) => {
									debug.warn('chat', 'Presence broadcast error on reconnect waiting-input state change:', err);
								});
							}
							if (reconnAskToolUse && projectId) {
								ws.emit.projectMembers(projectId, 'chat:waiting-input', {
									projectId,
									chatSessionId,
									toolUseId: reconnAskToolUse.id,
									timestamp: event.data.timestamp || new Date().toISOString()
								});
							}
							break;
						}

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

						case 'rate_limit':
							ws.emit.chatSession(chatSessionId, 'chat:rate_limit', {
								chatSessionId: event.data.chatSessionId,
								engine: event.data.engine,
								accountId: event.data.accountId,
								status: event.data.status,
								utilization: event.data.utilization,
								resetsAt: event.data.resetsAt,
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
					// Log but do NOT unsubscribe — same rationale as the initial
					// stream handler: a transient error must not permanently break
					// the EventEmitter → WS room bridge.
					debug.error('chat', 'Error handling reconnected stream event:', err);
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

	// Handle AskUserQuestion answer from user.
	//
	// Routed to the engine's built-in resolveUserAnswer (Claude: canUseTool,
	// OpenCode: event hook). Codex has no callback hook in the SDK — when
	// the SDK adds native support, route it here too instead of resurrecting
	// the previous MCP-based fallback.
	.on('chat:ask-user-answer', {
		data: t.Object({
			chatSessionId: t.String(),
			toolUseId: t.String(),
			answers: t.Record(t.String(), t.String())
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const projectId = ws.getProjectId(conn);

		try {
			debug.log('chat', 'WS chat:ask-user-answer received:', {
				chatSessionId: data.chatSessionId,
				toolUseId: data.toolUseId,
				answers: data.answers
			});

			const handled = streamManager.resolveUserAnswer(
				data.chatSessionId,
				projectId,
				data.toolUseId,
				data.answers
			);
			if (!handled) {
				debug.warn('chat', 'Failed to resolve user answer (no engine handler for this toolUseId)');
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			debug.error('chat', 'WS chat:ask-user-answer error:', errorMessage);
		}
	})

	// Get active stream state (for reconnect after browser refresh / project switch)
	.http('chat:stream-state', {
		data: t.Object({
			chatSessionId: t.Optional(t.String())
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
			currentReasoningText: t.Optional(t.String()),
			error: t.Optional(t.String()),
			startedAt: t.String(),
			completedAt: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		if (data.chatSessionId) {
			requireSessionAccess(conn, data.chatSessionId);
		}

		const streamState = data.chatSessionId
			? streamManager.getSessionStream(data.chatSessionId, projectId)
			: undefined;

		// Return a "not found" response instead of throwing
		// This happens normally when a stream was cancelled/completed and cleaned up
		if (!streamState) {
			return {
				streamId: data.chatSessionId || '',
				status: 'completed' as const,
				processId: '',
				messages: [],
				currentPartialText: undefined,
				currentReasoningText: undefined,
				error: undefined,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString()
			};
		}

		return {
			streamId: streamState.streamId,
			status: streamState.status,
			processId: streamState.processId,
			messages: streamState.messages,
			currentPartialText: streamState.currentPartialText,
			currentReasoningText: streamState.currentReasoningText,
			error: streamState.error,
			startedAt: streamState.startedAt.toISOString(),
			completedAt: streamState.completedAt?.toISOString()
		};
	})

	// Cancel stream
	.on('chat:cancel', {
		data: t.Object({
			sessionId: t.String(),
			chatSessionId: t.String()
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
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
				broadcastPresence().catch((err) => {
					debug.warn('chat', 'Presence broadcast error after cancel (stream not found):', err);
				});
				return;
			}

			await streamManager.cancelStream(streamState.streamId);
			// Always send cancelled to chat session room to clear UI
			ws.emit.chatSession(chatSessionId, 'chat:cancelled', {
				status: 'cancelled',
				processId: streamState.processId
			});
			// Always broadcast presence after cancel attempt to update all clients
			broadcastPresence().catch((err) => {
				debug.warn('chat', 'Presence broadcast error after stream cancel:', err);
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			ws.emit.chatSession(chatSessionId, 'chat:error', {
				processId: '',
				error: errorMessage,
				timestamp: new Date().toISOString()
			});
			broadcastPresence().catch((err) => {
				debug.warn('chat', 'Presence broadcast error after cancel exception:', err);
			});
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
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
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
	}, ({ data, conn }) => {
		const chatSessionId = data.chatSessionId || '';
		if (chatSessionId) {
			requireSessionAccess(conn, chatSessionId);
		}
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
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
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
	}, ({ data, conn }) => {
		const chatSessionId = data.chatSessionId || '';
		if (chatSessionId) {
			requireSessionAccess(conn, chatSessionId);
		}
		const state = chatSessionInputState.get(chatSessionId);
		return state || { text: '', senderId: '' };
	})

	// Collaborative model sync - broadcast model changes to other users in the same chat session
	.on('chat:model-sync', {
		data: t.Object({
			senderId: t.String(),
			chatSessionId: t.String(),
			engine: t.String(),
			provider: t.String(),
			modelId: t.String(),
			modelName: t.String()
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const chatSessionId = data.chatSessionId;

		// Store latest model state on server for late joiners / refresh
		chatSessionModelState.set(chatSessionId, {
			engine: data.engine,
			provider: data.provider,
			modelId: data.modelId,
			modelName: data.modelName,
			senderId: data.senderId
		});

		// Persist engine/model to the session record in the database
		// so refreshes and late joiners get the correct model
		try {
			sessionQueries.updateEngineModel(chatSessionId, data.engine, data.provider, data.modelId, data.modelName);
		} catch (err) {
			debug.error('chat', 'Failed to persist model sync to DB:', err);
		}

		// Broadcast to all users in the same chat session
		ws.emit.chatSession(chatSessionId, 'chat:model-sync', {
			senderId: data.senderId,
			engine: data.engine,
			provider: data.provider,
			modelId: data.modelId,
			modelName: data.modelName
		});
	})

	// Collaborative account sync - broadcast account changes to other users in the same chat session
	.on('chat:account-sync', {
		data: t.Object({
			senderId: t.String(),
			chatSessionId: t.String(),
			accountId: t.Union([t.Number(), t.Null()]),
			accountName: t.Optional(t.Union([t.String(), t.Null()]))
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const chatSessionId = data.chatSessionId;

		// Store latest account state on server for late joiners / refresh
		chatSessionAccountState.set(chatSessionId, {
			accountId: data.accountId,
			senderId: data.senderId
		});

		// Persist account to the session record in the database
		try {
			sessionQueries.updateAccount(chatSessionId, data.accountId, data.accountName ?? null);
		} catch (err) {
			debug.error('chat', 'Failed to persist account sync to DB:', err);
		}

		// Broadcast to all users in the same chat session
		ws.emit.chatSession(chatSessionId, 'chat:account-sync', {
			senderId: data.senderId,
			accountId: data.accountId,
			accountName: data.accountName ?? null
		});
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
		provider: t.String(),
		modelId: t.String(),
		modelName: t.String()
	}))

	.emit('chat:account-sync', t.Object({
		senderId: t.String(),
		accountId: t.Union([t.Number(), t.Null()]),
		accountName: t.Union([t.String(), t.Null()])
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

	.emit('chat:rate_limit', t.Object({
		chatSessionId: t.String(),
		engine: t.String(),
		accountId: t.Number(),
		status: t.Union([t.Literal('allowed_warning'), t.Literal('rejected')]),
		utilization: t.Number(),
		resetsAt: t.Union([t.Number(), t.Null()]),
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
		timestamp: t.String(),
		reason: t.Optional(t.String())
	}))

	.emit('chat:waiting-input', t.Object({
		projectId: t.String(),
		chatSessionId: t.String(),
		toolUseId: t.String(),
		timestamp: t.String()
	}))

	.emit('snapshot:captured', t.Object({
		projectId: t.String(),
		chatSessionId: t.String()
	}));
