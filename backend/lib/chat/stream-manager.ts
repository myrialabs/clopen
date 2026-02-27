/**
 * Stream Manager - Background Service for Chat Streams (Optimized)
 *
 * High-performance chat stream manager with:
 * - Event-driven push model (no polling)
 * - Background processing that continues even when browser is closed
 * - Reconnection to active streams after browser refresh
 * - Multiple concurrent streams per user/session
 */

import { EventEmitter } from 'events';
import type { SDKMessage, SSEEventData, SDKCompactBoundaryMessage, SDKPartialAssistantMessage, SDKUserMessage, EngineSDKMessage } from '$shared/types/messaging';
import type { DatabaseMessage } from '$shared/types/database/schema';
import type { EngineType } from '$shared/types/engine';
import { getProjectEngine, initializeProjectEngine } from '../engine';
import { messageQueries, sessionQueries } from '../database/queries';
import { snapshotService } from '../snapshot/snapshot-service';
import { projectContextService } from '../mcp/project-context';
import { browserMcpControl } from '../preview';
import { debug } from '$shared/utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface StreamState {
	streamId: string;
	chatSessionId: string;
	projectId?: string;
	projectPath?: string;
	processId: string;
	engine: EngineType;
	status: 'active' | 'completed' | 'error' | 'cancelled';
	startedAt: Date;
	completedAt?: Date;
	messages: SSEEventData[];
	currentMessage?: SDKMessage;
	currentPartialText?: string;
	currentReasoningText?: string;
	error?: string;
	abortController?: AbortController;
	streamPromise?: Promise<void>;
	sdkSessionId?: string;
	hasCompactBoundary?: boolean;
	eventSeq: number; // Sequence number for deduplication
}

interface StreamRequest {
	projectPath: string;
	projectId?: string;
	prompt: SDKUserMessage;
	messages: any[];
	chatSessionId: string;
	engine?: EngineType;
	model?: string;
	temperature?: number;
	senderId?: string;
	senderName?: string;
	claudeAccountId?: number;
}

// ============================================================================
// Stream Event Types
// ============================================================================

export type StreamEventType =
	| 'connection'
	| 'message'
	| 'partial'
	| 'notification'
	| 'complete'
	| 'error'
	| 'cancelled';

export interface StreamEvent {
	type: StreamEventType;
	streamId: string;
	processId: string;
	data: any;
	timestamp: string;
	seq: number; // Sequence number for deduplication
}

// ============================================================================
// Stream Manager
// ============================================================================

class StreamManager extends EventEmitter {
	private activeStreams = new Map<string, StreamState>();
	private sessionStreams = new Map<string, string>(); // composite key -> streamId
	/** Guard against duplicate lifecycle events (e.g. if both inner and outer error paths fire) */
	private lifecycleEmitted = new Set<string>();

	constructor() {
		super();
		// Increase max listeners for high concurrency
		this.setMaxListeners(1000);
	}

	/**
	 * Emit a global lifecycle event when a stream reaches a terminal state.
	 * This event fires regardless of per-connection subscribers.
	 * Used by the WS layer to send cross-project notifications (presence, sound, push).
	 */
	private emitStreamLifecycle(streamState: StreamState, status: 'completed' | 'error' | 'cancelled'): void {
		if (this.lifecycleEmitted.has(streamState.streamId)) return;
		this.lifecycleEmitted.add(streamState.streamId);

		this.emit('stream:lifecycle', {
			status,
			streamId: streamState.streamId,
			projectId: streamState.projectId,
			chatSessionId: streamState.chatSessionId,
			timestamp: (streamState.completedAt || new Date()).toISOString()
		});

		// Clean up guard after 60s (no need to keep forever)
		setTimeout(() => this.lifecycleEmitted.delete(streamState.streamId), 60000);
	}

	/**
	 * Start a new background stream
	 */
	async startStream(request: StreamRequest): Promise<string> {
		const streamId = crypto.randomUUID();
		const processId = crypto.randomUUID();

		// Check if there's already an active stream for this chat session + project
		const sessionKey = this.getSessionKey(request.projectId, request.chatSessionId);
		const existingStreamId = this.sessionStreams.get(sessionKey);
		if (existingStreamId) {
			const existingStream = this.activeStreams.get(existingStreamId);
			if (existingStream && existingStream.status === 'active') {
				if (existingStream.projectId === request.projectId) {
					return existingStreamId;
				}
			}
		}

		// Initialize stream state
		const streamState: StreamState = {
			streamId,
			chatSessionId: request.chatSessionId,
			projectId: request.projectId,
			projectPath: request.projectPath,
			processId,
			engine: request.engine || 'claude-code',
			status: 'active',
			startedAt: new Date(),
			messages: [],
			abortController: new AbortController(),
			eventSeq: 0 // Initialize sequence for deduplication
		};

		this.activeStreams.set(streamId, streamState);
		this.sessionStreams.set(sessionKey, streamId);

		// Save engine+model+account to session for persistence across refresh/switch
		if (request.chatSessionId) {
			try {
				const compoundModelId = `${request.engine || 'claude-code'}:${request.model || 'sonnet'}`;
				sessionQueries.updateEngineModel(
					request.chatSessionId,
					request.engine || 'claude-code',
					compoundModelId
				);
				if (request.claudeAccountId !== undefined) {
					sessionQueries.updateClaudeAccountId(request.chatSessionId, request.claudeAccountId);
				}
			} catch (error) {
				debug.error('chat', 'Failed to save engine/model to session:', error);
			}
		}

		// Register session -> projectId mapping for MCP context
		if (request.projectId) {
			projectContextService.registerSession(request.chatSessionId, request.projectId);
			projectContextService.registerStream(streamId, request.projectId, request.chatSessionId);
		}

		// Emit connection event immediately
		this.emitStreamEvent(streamState, 'connection', {
			processId,
			timestamp: streamState.startedAt.toISOString()
		});

		// Start background processing
		streamState.streamPromise = this.processStream(streamState, request).catch(error => {
			streamState.status = 'error';
			streamState.error = this.extractErrorDetail(error);
			streamState.completedAt = new Date();

			this.emitStreamEvent(streamState, 'error', {
				processId: streamState.processId,
				error: streamState.error,
				timestamp: streamState.completedAt.toISOString()
			});

			this.emitStreamLifecycle(streamState, 'error');
		});

		// Auto-cleanup after 5 minutes (fallback for completed/error streams)
		setTimeout(() => {
			if (streamState.status !== 'active') {
				this.cleanupStream(streamId);
			}
		}, 5 * 60 * 1000);

		return streamId;
	}

	/**
	 * Emit a stream event to all subscribers
	 */
	private emitStreamEvent(streamState: StreamState, type: StreamEventType, data: any): void {
		// Increment sequence number for deduplication
		streamState.eventSeq++;

		// Attach engine type to all event data for frontend metadata
		if (data && typeof data === 'object') {
			data.engine = streamState.engine;
		}

		const event: StreamEvent = {
			type,
			streamId: streamState.streamId,
			processId: streamState.processId,
			data,
			timestamp: new Date().toISOString(),
			seq: streamState.eventSeq
		};

		// Emit to stream-specific channel only
		// (session channel removed to prevent duplicate dispatches)
		this.emit(`stream:${streamState.streamId}`, event);
	}

	/**
	 * Subscribe to a stream's events
	 */
	subscribeToStream(streamId: string, handler: (event: StreamEvent) => void): () => void {
		const eventName = `stream:${streamId}`;
		this.on(eventName, handler);

		// Return unsubscribe function
		return () => {
			this.off(eventName, handler);
		};
	}

	/**
	 * Subscribe to a session's events (for reconnection)
	 */
	subscribeToSession(projectId: string | undefined, chatSessionId: string, handler: (event: StreamEvent) => void): () => void {
		const sessionKey = this.getSessionKey(projectId, chatSessionId);
		const eventName = `session:${sessionKey}`;
		this.on(eventName, handler);

		return () => {
			this.off(eventName, handler);
		};
	}

	/**
	 * Process stream in background
	 */
	private async processStream(streamState: StreamState, requestData: StreamRequest): Promise<void> {
		// Track user message ID for stream-end snapshot capture
		let userMessageId: string | undefined;

		try {
			const { projectPath, prompt, chatSessionId, engine: engineType = 'claude-code', model, temperature, claudeAccountId } = requestData;

			// Validate project path
			const projectPathExists = projectPath ? await this.existsSync(projectPath) : false;
			if (!projectPath) {
				throw new Error('Project path is required. Please select a valid project directory.');
			}
			if (!projectPathExists) {
				throw new Error(`Project path does not exist: ${projectPath}. Please select a valid project directory.`);
			}
			const actualProjectPath = projectPath;

			// Get resume session ID
			let resumeSessionId: string | undefined = undefined;
			if (chatSessionId) {
				try {
					const chatSession = sessionQueries.getById(chatSessionId);
					if (chatSession?.latest_sdk_session_id) {
						resumeSessionId = chatSession.latest_sdk_session_id;
					}
				} catch (error) {
					debug.error('chat', 'Failed to get chat session for resume:', error);
				}
			}

			// Prepare user message
			const userMessage = {
				...(prompt as SDKMessage),
				resume: resumeSessionId ?? null
			} as SDKMessage & { resume: string | null };

			// Save user message
			const userMessageTimestamp = new Date().toISOString();
			const savedMessage = await this.saveMessage(
				userMessage as SDKMessage,
				chatSessionId,
				userMessageTimestamp,
				requestData.senderId,
				requestData.senderName
			);

			// Track user message ID for stream-end snapshot
			userMessageId = savedMessage?.id;

			// Add user message to stream state and emit
			// Keep SDK message clean — non-SDK info goes as transport fields
			streamState.messages.push({
				processId: streamState.processId,
				message: userMessage,
				timestamp: userMessageTimestamp,
				message_id: savedMessage?.id,
				parent_message_id: savedMessage?.parent_message_id || null,
				sender_id: requestData.senderId,
				sender_name: requestData.senderName
			});

			// Emit user message event
			this.emitStreamEvent(streamState, 'message', {
				processId: streamState.processId,
				message: userMessage,
				timestamp: userMessageTimestamp,
				message_id: savedMessage?.id,
				parent_message_id: savedMessage?.parent_message_id || null,
				sender_id: requestData.senderId,
				sender_name: requestData.senderName
			});

			// Check for cancellation after saving user message (async DB operation)
			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled after saving user message, skipping query');
				return;
			}

			let sdkSessionId: string | null = null;
			// Track last assistant text for deduplication — some engines (Claude Code) can
			// emit identical error messages multiple times (e.g. on process exit retry).
			let lastAssistantTextContent: string | null = null;

			// Get per-project engine instance for stream isolation.
			// Each project gets its own engine so cancel/abort only affects this project.
			const projectId = streamState.projectId || 'default';

			// Check if already cancelled BEFORE initializing the engine.
			// This prevents starting a new engine query with an already-aborted controller,
			// which can cause unhandled rejections in the SDK and crash the server.
			// Note: status is mutated to 'cancelled' by cancelStream() from a different async context;
			// TypeScript's control flow analysis doesn't track this, so we cast to string.
			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled before engine initialization, skipping query');
				return;
			}

			const engine = await initializeProjectEngine(projectId, engineType);

			// Check again after async engine initialization — cancellation may have occurred
			// while awaiting initialization
			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled during engine initialization, skipping query');
				return;
			}

			// Stream messages through the engine adapter
			for await (const message of engine.streamQuery({
				projectPath: actualProjectPath,
				prompt: prompt,
				resume: resumeSessionId,
				model: model || 'sonnet',
				includePartialMessages: true,
				abortController: streamState.abortController,
				...(claudeAccountId !== undefined && { claudeAccountId }),
			})) {
				// Check if cancelled (cancelStream() already set status and emitted event)
				if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
					break;
				}

				// Update SDK session ID
				if (!sdkSessionId && message.session_id) {
					sdkSessionId = message.session_id;
					streamState.sdkSessionId = sdkSessionId;
					if (chatSessionId) {
						try {
							sessionQueries.updateLatestSdkSessionId(chatSessionId, sdkSessionId);
						} catch (error) {
							// Ignore
						}
					}
				}

				// Handle system init message - Check MCP server status, then skip DB save.
				// System init messages are SDK metadata (not conversation content) and don't need
				// to be persisted or snapshotted. Saving them adds unnecessary latency from git ops.
				if (message.type === 'system' && message.subtype === 'init') {
					const systemMessage = message as any;

					// Check for failed MCP servers
					if (systemMessage.mcp_servers && Array.isArray(systemMessage.mcp_servers)) {
						const failedServers = systemMessage.mcp_servers.filter(
							(server: any) => server.status !== 'connected'
						);

						// Emit warning notification for each failed server
						failedServers.forEach((server: any) => {
							debug.warn('mcp', `MCP server connection failed: ${server.name} (${server.status})`);

							this.emitStreamEvent(streamState, 'notification', {
								notification: {
									type: 'warning',
									title: 'MCP Server Connection Failed',
									message: `Failed to connect to custom MCP server "${server.name}". Status: ${server.status}`,
									icon: 'lucide:alert-triangle'
								},
								timestamp: new Date().toISOString()
							});
						});

						// Log successful connections
						const connectedServers = systemMessage.mcp_servers.filter(
							(server: any) => server.status === 'connected'
						);
						if (connectedServers.length > 0) {
							debug.log('mcp', `✓ Connected MCP servers: ${connectedServers.map((s: any) => s.name).join(', ')}`);
						}
					}

					// Skip DB save — system init is engine metadata, not conversation content
					continue;
				}

				// Handle compact boundary messages
				if (message.type === 'system' && message.subtype === 'compact_boundary') {
					const compactMessage = message as SDKCompactBoundaryMessage;
					streamState.hasCompactBoundary = true;

					streamState.messages.push({
						processId: streamState.processId,
						message,
						timestamp: new Date().toISOString(),
						compactBoundary: {
							trigger: compactMessage.compact_metadata.trigger,
							preTokens: compactMessage.compact_metadata.pre_tokens
						}
					});

					this.emitStreamEvent(streamState, 'notification', {
						notification: {
							type: 'info',
							title: 'Conversation Compacted',
							message: `Conversation history has been compacted (${compactMessage.compact_metadata.trigger} trigger).`,
							icon: 'lucide:layers'
						},
						timestamp: new Date().toISOString()
					});
					continue;
				}

				// Handle partial messages (streaming events)
				if (message.type === 'stream_event') {
					const partialMessage = message as SDKPartialAssistantMessage;
					const event = partialMessage.event;
					const isReasoning = message.metadata?.reasoning === true;

					if (event.type === 'message_start') {
						if (isReasoning) {
							streamState.currentReasoningText = '';
						} else {
							streamState.currentPartialText = '';
						}
						this.emitStreamEvent(streamState, 'partial', {
							processId: streamState.processId,
							eventType: 'start',
							partialText: '',
							deltaText: '',
							...(isReasoning && { reasoning: true }),
							timestamp: new Date().toISOString()
						});
					} else if (event.type === 'content_block_start') {
						debug.log('chat', `[SM] content_block_start: type=${(event as any).content_block?.type}`);
						// Claude Code: detect thinking blocks
						if ((event as any).content_block?.type === 'thinking') {
							streamState.currentReasoningText = '';
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'start',
								partialText: '',
								deltaText: '',
								reasoning: true,
								timestamp: new Date().toISOString()
							});
						} else if ((event as any).content_block?.type === 'text') {
							// Reset partial text for new text content block
							// Don't emit the initial text — deltas will provide the content
							// This prevents double-counting if content_block_start.text repeats
							// the first content_block_delta.text
							streamState.currentPartialText = '';
						}
					} else if (event.type === 'content_block_delta') {
						debug.log('chat', `[SM] content_block_delta: deltaType=${(event as any).delta?.type}, hasThinking=${'thinking' in ((event as any).delta || {})}, hasText=${'text' in ((event as any).delta || {})}`);
						// Claude Code: thinking deltas
						if (event.delta && 'thinking' in (event.delta as any)) {
							const thinkingText = (event.delta as any).thinking;
							streamState.currentReasoningText = (streamState.currentReasoningText || '') + thinkingText;
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'update',
								partialText: streamState.currentReasoningText,
								deltaText: thinkingText,
								reasoning: true,
								timestamp: new Date().toISOString()
							});
						} else if (event.delta && 'text' in event.delta) {
							if (isReasoning) {
								// Open Code: reasoning delta (packaged as text_delta with metadata.reasoning flag)
								const deltaText = event.delta.text;
								streamState.currentReasoningText = (streamState.currentReasoningText || '') + deltaText;
								this.emitStreamEvent(streamState, 'partial', {
									processId: streamState.processId,
									eventType: 'update',
									partialText: streamState.currentReasoningText,
									deltaText: deltaText,
									reasoning: true,
									timestamp: new Date().toISOString()
								});
							} else {
								// Regular text delta
								const deltaText = event.delta.text;
								streamState.currentPartialText = (streamState.currentPartialText || '') + deltaText;
								this.emitStreamEvent(streamState, 'partial', {
									processId: streamState.processId,
									eventType: 'update',
									partialText: streamState.currentPartialText,
									deltaText: deltaText,
									timestamp: new Date().toISOString()
								});
							}
						}
					} else if (event.type === 'content_block_stop') {
						// Claude Code: end of a thinking block — emit reasoning end and clear state
						if (streamState.currentReasoningText) {
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'end',
								partialText: streamState.currentReasoningText,
								deltaText: '',
								reasoning: true,
								timestamp: new Date().toISOString()
							});
							// Clear so subsequent content_block_stop (text/tool) doesn't re-trigger
							streamState.currentReasoningText = '';
						}
					} else if (event.type === 'message_stop') {
						if (isReasoning) {
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'end',
								partialText: streamState.currentReasoningText || '',
								deltaText: '',
								reasoning: true,
								timestamp: new Date().toISOString()
							});
						} else {
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'end',
								partialText: streamState.currentPartialText || '',
								deltaText: '',
								timestamp: new Date().toISOString()
							});
						}
					}
					continue;
				}

				// Split Claude Code assistant messages that contain thinking blocks
				// into separate reasoning + text messages
				if (message.type === 'assistant' && !message.metadata?.reasoning
					&& Array.isArray(message.message?.content)) {
					const content = (message as any).message.content;
					const contentTypes = content.map((b: any) => b.type);
					debug.log('chat', `[SM] assistant message content types: ${JSON.stringify(contentTypes)}`);
					const thinkingBlocks = content.filter((b: any) => b.type === 'thinking');

					if (thinkingBlocks.length > 0) {
						const reasoningText = thinkingBlocks
							.map((b: any) => b.thinking || '')
							.join('\n');
						const otherBlocks = content.filter((b: any) => b.type !== 'thinking');

						// 1. Emit reasoning message
						// Synthetic reasoning message — extracted thinking blocks as text
						const reasoningMsg = {
							type: 'assistant' as const,
							message: {
								...message.message,
								content: [{ type: 'text' as const, text: reasoningText }],
							},
							uuid: crypto.randomUUID(),
							session_id: message.session_id,
							parent_tool_use_id: null,
							metadata: { reasoning: true },
						} as unknown as EngineSDKMessage;

						const reasoningTimestamp = new Date().toISOString();
						let savedReasoningId: string | undefined;
						let savedReasoningParentId: string | null = null;
						if (chatSessionId) {
							const saved = await this.saveMessage(
								reasoningMsg, chatSessionId, reasoningTimestamp,
								requestData.senderId, requestData.senderName
							);
							savedReasoningId = saved?.id;
							savedReasoningParentId = saved?.parent_message_id || null;
						}

						this.emitStreamEvent(streamState, 'message', {
							processId: streamState.processId,
							message: reasoningMsg,
							timestamp: reasoningTimestamp,
							message_id: savedReasoningId,
							parent_message_id: savedReasoningParentId,
							sender_id: requestData.senderId,
							sender_name: requestData.senderName
						});

						// 2. Strip thinking blocks from original message
						(message as any).message.content = otherBlocks.length > 0
							? otherBlocks
							: [{ type: 'text', text: '' }];
					}
				}

				// Deduplicate consecutive identical assistant messages.
				// Some engines (e.g. Claude Code on process exit) can emit the same error
				// text multiple times. Skip if current text matches the previous assistant message.
				if (message.type === 'assistant' && !message.metadata?.reasoning) {
					const content = message.message?.content;
					if (Array.isArray(content)) {
						const currentText = content
							.filter((c: any) => c.type === 'text')
							.map((c: any) => c.text as string)
							.join('');
						if (currentText && currentText === lastAssistantTextContent) {
							debug.warn('chat', 'Skipping duplicate consecutive assistant message');
							continue;
						}
						if (currentText) lastAssistantTextContent = currentText;
					}
				} else if (message.type !== 'assistant') {
					// Reset tracker on non-assistant messages (user/system/tool result)
					lastAssistantTextContent = null;
				}

				// Handle complete messages
				const usage = message.type === 'assistant' && message.message?.usage
					? message.message.usage
					: undefined;

				const messageTimestamp = new Date().toISOString();

				// Save to database first to get message_id and parent_message_id
				let savedMsgId: string | undefined;
				let savedParentId: string | null = null;
				if (chatSessionId) {
					const saved = await this.saveMessage(
						message,
						chatSessionId,
						messageTimestamp,
						requestData.senderId,
						requestData.senderName
					);
					savedMsgId = saved?.id;
					savedParentId = saved?.parent_message_id || null;
				}

				streamState.messages.push({
					processId: streamState.processId,
					message,
					usage,
					timestamp: messageTimestamp,
					message_id: savedMsgId,
					parent_message_id: savedParentId,
					sender_id: requestData.senderId,
					sender_name: requestData.senderName
				});

				streamState.currentMessage = message;

				// Emit message event
				this.emitStreamEvent(streamState, 'message', {
					processId: streamState.processId,
					message,
					usage,
					timestamp: messageTimestamp,
					message_id: savedMsgId,
					parent_message_id: savedParentId,
					sender_id: requestData.senderId,
					sender_name: requestData.senderName
				});
			}

			// Only mark as completed if not already cancelled/errored
			if (streamState.status === 'active') {
				streamState.status = 'completed';
				streamState.completedAt = new Date();

				this.emitStreamEvent(streamState, 'complete', {
					processId: streamState.processId,
					timestamp: streamState.completedAt.toISOString()
				});

				this.emitStreamLifecycle(streamState, 'completed');
			}

			// Auto-release MCP control when stream completes
			browserMcpControl.releaseControl();
			debug.log('mcp', '✅ Auto-released MCP control on stream completion');

		} catch (error) {
			// Don't overwrite status if already cancelled by cancelStream()
			if (streamState.status !== 'cancelled') {
				streamState.status = 'error';
				streamState.error = this.extractErrorDetail(error);
				streamState.completedAt = new Date();

				const errorTimestamp = streamState.completedAt.toISOString();

				// Build a synthetic assistant message for the error so it is saved to DB
				// and persists across browser refresh (not just an ephemeral UI injection).
				const errorAssistantMsg = {
					type: 'assistant' as const,
					uuid: crypto.randomUUID(),
					session_id: streamState.sdkSessionId || '',
					parent_tool_use_id: null,
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: `**Error:** ${streamState.error}` }],
					},
				} as EngineSDKMessage;

				// Save error message to DB (no snapshot needed for error messages)
				let savedErrorMsgId: string | undefined;
				let savedErrorParentId: string | null = null;
				if (requestData.chatSessionId) {
					const saved = await this.saveMessage(
						errorAssistantMsg,
						requestData.chatSessionId,
						errorTimestamp,
						requestData.senderId,
						requestData.senderName
					);
					savedErrorMsgId = saved?.id;
					savedErrorParentId = saved?.parent_message_id || null;
				}

				// Emit as chat:message so the error appears in the conversation list
				// and is loaded from DB on browser refresh
				this.emitStreamEvent(streamState, 'message', {
					processId: streamState.processId,
					message: errorAssistantMsg,
					timestamp: errorTimestamp,
					message_id: savedErrorMsgId,
					parent_message_id: savedErrorParentId,
					sender_id: requestData.senderId,
					sender_name: requestData.senderName,
				});

				// Emit chat:error to signal stream termination (triggers isLoading=false,
				// sound/push notification, and stream cleanup on the frontend)
				this.emitStreamEvent(streamState, 'error', {
					processId: streamState.processId,
					error: streamState.error,
					timestamp: errorTimestamp
				});

				this.emitStreamLifecycle(streamState, 'error');
			}

			// Auto-release MCP control on stream error
			browserMcpControl.releaseControl();
			debug.log('mcp', '✅ Auto-released MCP control on stream error');
		} finally {
			// Capture snapshot ONCE at stream end (regardless of completion/error/cancel).
			// Associates the snapshot with the user message (checkpoint) that triggered the stream.
			const { projectPath, projectId, chatSessionId } = requestData;
			if (projectPath && projectId && chatSessionId && userMessageId) {
				snapshotService.captureSnapshot(projectPath, projectId, chatSessionId, userMessageId)
					.then(() => debug.log('chat', `Stream-end snapshot captured for message: ${userMessageId}`))
					.catch(err => debug.error('chat', 'Failed to capture stream-end snapshot:', err));
			}
		}
	}

	/**
	 * Get stream state by ID
	 */
	getStream(streamId: string): StreamState | undefined {
		return this.activeStreams.get(streamId);
	}

	/**
	 * Get active stream for a chat session
	 */
	getSessionStream(chatSessionId: string, projectId?: string): StreamState | undefined {
		if (projectId) {
			const sessionKey = this.getSessionKey(projectId, chatSessionId);
			const streamIdWithProject = this.sessionStreams.get(sessionKey);
			if (streamIdWithProject) {
				const stream = this.activeStreams.get(streamIdWithProject);
				if (stream) return stream;
			}
		}

		// Legacy fallback
		const streamId = this.sessionStreams.get(chatSessionId);
		if (!streamId) return undefined;
		return this.activeStreams.get(streamId);
	}

	/**
	 * Generate session key
	 */
	private getSessionKey(projectId: string | undefined, chatSessionId: string): string {
		return projectId ? `${projectId}-${chatSessionId}` : chatSessionId;
	}

	/**
	 * Cancel an active stream
	 */
	async cancelStream(streamId: string): Promise<boolean> {
		const streamState = this.activeStreams.get(streamId);
		if (!streamState || streamState.status !== 'active') {
			return false;
		}

		// Mark as cancelled FIRST to prevent further message processing
		streamState.status = 'cancelled';
		streamState.completedAt = new Date();

		// Save partial text to DB before cancelling (persists across refresh/project switch)
		if (streamState.currentPartialText && streamState.chatSessionId) {
			try {
				const partialMessage = {
					type: 'assistant' as const,
					parent_tool_use_id: null,
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: streamState.currentPartialText }]
					},
					session_id: streamState.sdkSessionId || '',
					partialText: streamState.currentPartialText
				};

				const timestamp = new Date().toISOString();
				const currentHead = sessionQueries.getHead(streamState.chatSessionId);

				const savedMessage = messageQueries.create({
					session_id: streamState.chatSessionId,
					sdk_message: partialMessage as any,
					timestamp,
					parent_message_id: currentHead || undefined
				});

				sessionQueries.updateHead(streamState.chatSessionId, savedMessage.id);
				debug.log('chat', 'Saved partial text on cancel:', savedMessage.id);
			} catch (error) {
				debug.error('chat', 'Failed to save partial text on cancel:', error);
			}
		}

		// Abort the stream-manager's controller FIRST.
		// This ensures processStream() sees the abort signal at its next check point
		// and avoids starting a new engine query with an already-aborted controller.
		streamState.abortController?.abort();

		// Cancel the per-project engine — this is safe because each project
		// has its own engine instance (via getProjectEngine), so cancel()
		// only affects this project's active query/session, not other projects.
		// Wrapped in try/catch to prevent SDK errors from crashing the server.
		const projectId = streamState.projectId || 'default';
		try {
			const engine = getProjectEngine(projectId, streamState.engine);
			if (engine.isActive) {
				await engine.cancel();
			}
		} catch (error) {
			debug.error('chat', 'Error cancelling engine (non-fatal):', error);
		}

		this.emitStreamEvent(streamState, 'cancelled', {
			processId: streamState.processId,
			timestamp: streamState.completedAt.toISOString()
		});

		this.emitStreamLifecycle(streamState, 'cancelled');

		// Auto-release MCP control on stream cancellation
		browserMcpControl.releaseControl();
		debug.log('mcp', '✅ Auto-released MCP control on stream cancellation');

		return true;
	}

	/**
	 * Clean up a stream
	 */
	private cleanupStream(streamId: string): void {
		const streamState = this.activeStreams.get(streamId);
		if (streamState) {
			const sessionKey = this.getSessionKey(streamState.projectId, streamState.chatSessionId);
			this.sessionStreams.delete(sessionKey);
			this.sessionStreams.delete(streamState.chatSessionId);
			this.activeStreams.delete(streamId);

			// Cleanup project context service
			projectContextService.unregisterStream(streamId);

			// Remove all listeners for this stream
			this.removeAllListeners(`stream:${streamId}`);
			this.removeAllListeners(`session:${sessionKey}`);
		}
	}

	/**
	 * Get all active streams
	 */
	getActiveStreams(): StreamState[] {
		return Array.from(this.activeStreams.values())
			.filter(stream => stream.status === 'active');
	}

	/**
	 * Save message to database
	 */
	private async saveMessage(
		message: EngineSDKMessage,
		sessionId: string,
		timestamp: string,
		senderId?: string,
		senderName?: string
	): Promise<DatabaseMessage | null> {
		try {
			const currentHead = sessionQueries.getHead(sessionId);

			const savedMessage = messageQueries.create({
				session_id: sessionId,
				sdk_message: message,
				timestamp,
				sender_id: senderId,
				sender_name: senderName,
				parent_message_id: currentHead || undefined
			});

			sessionQueries.updateHead(sessionId, savedMessage.id);

			// Update checkpoint_tree_state when saving a new checkpoint (real user message)
			if (message.type === 'user') {
				try {
					const { isCheckpointMessage, buildCheckpointTree, getCheckpointPathToRoot } = await import('../../lib/snapshot/helpers');
					const { checkpointQueries } = await import('../database/queries');

					// Check if this new message is a checkpoint
					if (isCheckpointMessage(savedMessage)) {
						const allMessages = messageQueries.getAllBySessionId(sessionId);
						const { parentMap } = buildCheckpointTree(allMessages);

						// Update active children along path from root to this new checkpoint
						const checkpointPath = getCheckpointPathToRoot(savedMessage.id, parentMap);
						if (checkpointPath.length > 1) {
							checkpointQueries.updateActiveChildrenAlongPath(sessionId, checkpointPath);
						}

						debug.log('snapshot', `Checkpoint tree state updated for new checkpoint ${savedMessage.id.slice(0, 8)}`);
					}
				} catch (err) {
					debug.error('snapshot', 'Failed to update checkpoint tree state:', err);
				}
			}

			return savedMessage;
		} catch (error) {
			debug.error('chat', 'Failed to save message to database:', error);
			return null;
		}
	}

	/**
	 * Extract detailed error info from an error object.
	 * Handles engine-specific error shapes (Anthropic APIError, OpenCode SDK errors).
	 */
	private extractErrorDetail(error: unknown): string {
		if (!error) return 'Unknown error';
		if (typeof error === 'string') return this.normalizeErrorText(error);
		if (!(error instanceof Error)) return this.normalizeErrorText(String(error));

		const err = error as Record<string, any>;
		let message = err.message || 'Unknown error';

		// Enrich with status code if available (Anthropic APIError has .status)
		if (err.status && !message.includes(String(err.status))) {
			message += ` (status ${err.status})`;
		}

		// Enrich with nested error body (Anthropic APIError has .error.message)
		if (err.error?.message && !message.includes(err.error.message)) {
			message += ` - ${err.error.message}`;
		}

		return this.normalizeErrorText(message);
	}

	/**
	 * Strip redundant error class name prefixes from error text.
	 *
	 * Error text often passes through multiple wrapping layers (SDK → adapter → stream-manager),
	 * each potentially adding class names and "Error:" prefixes. This strips them:
	 *
	 *  "APIError: Bad Request: ..."                → "Bad Request: ..."
	 *  "UnknownError: Error: Unable to connect..." → "Unable to connect..."
	 *  "Claude Code process exited with code 1"    → unchanged
	 */
	private normalizeErrorText(text: string): string {
		let cleaned = text;

		// Strip error class name prefixes (e.g. "APIError: ", "UnknownError: ", "BadRequestError: ")
		cleaned = cleaned.replace(/^[A-Za-z]*Error:\s*/, '');

		// Strip a second redundant "Error: " that may remain (e.g. "UnknownError: Error: ...")
		cleaned = cleaned.replace(/^Error:\s*/, '');

		return cleaned.trim() || text;
	}

	/**
	 * Check if file exists
	 */
	private async existsSync(filePath: string): Promise<boolean> {
		try {
			const file = Bun.file(filePath);
			await file.stat();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get all streams for a specific project
	 */
	getProjectStreams(projectId: string): StreamState[] {
		const projectStreams: StreamState[] = [];
		this.activeStreams.forEach(stream => {
			if (stream.projectId === projectId) {
				projectStreams.push(stream);
			}
		});
		return projectStreams;
	}

	/**
	 * Get all streams
	 */
	getAllStreams(): StreamState[] {
		return Array.from(this.activeStreams.values());
	}

	/**
	 * Check if project has active streams
	 */
	hasActiveStreams(projectId: string): boolean {
		for (const stream of this.activeStreams.values()) {
			if (stream.projectId === projectId && stream.status === 'active') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Clean up completed streams for a project
	 */
	cleanupProjectStreams(projectId: string): void {
		const streamsToClean: string[] = [];

		this.activeStreams.forEach((stream, streamId) => {
			if (stream.projectId === projectId &&
					(stream.status === 'completed' || stream.status === 'error' || stream.status === 'cancelled')) {
				streamsToClean.push(streamId);
			}
		});

		streamsToClean.forEach(streamId => {
			this.cleanupStream(streamId);
		});
	}

	/**
	 * Clean up all completed streams
	 */
	cleanupAllCompletedStreams(): void {
		const streamsToClean: string[] = [];

		this.activeStreams.forEach((stream, streamId) => {
			if (stream.status !== 'active') {
				streamsToClean.push(streamId);
			}
		});

		streamsToClean.forEach(streamId => {
			this.cleanupStream(streamId);
		});
	}
}

// Export singleton instance
export const streamManager = new StreamManager();
