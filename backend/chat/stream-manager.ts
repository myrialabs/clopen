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
import type {
	EngineOutput,
	UnifiedMessage,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	CompactBoundaryMessage,
	StreamEvent as UnifiedStreamEvent,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	ErrorResultEvent,
	SystemInitEvent,
	RateLimitEvent,
	TokenUsage,
	StopReason,
	UserContentBlock,
	StreamRequest,
} from '$shared/types/unified';
import type { EngineType } from '$shared/types/unified';
import type { DatabaseMessage } from '$shared/types/database/schema';
import { getProjectEngine, initializeProjectEngine } from '../engine';
import { messageQueries, sessionQueries } from '../database/queries';
import { snapshotService } from '../snapshot/snapshot-service';
import { projectContextService } from '../mcp/project-context';
import { browserMcpControl } from '../preview';
import { extractMessageText } from '../snapshot/helpers';
import { debug } from '$shared/utils/logger';
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '$shared/constants/engines';

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
	messages: unknown[];
	currentMessage?: UnifiedMessage;
	currentPartialText?: string;
	currentReasoningText?: string;
	error?: string;
	abortController?: AbortController;
	streamPromise?: Promise<void>;
	sdkSessionId?: string;
	preStreamSessionId?: string | null;
	hasCompactBoundary?: boolean;
	eventSeq: number;
}

// ============================================================================
// SDK → Unified Prompt Converter
// ============================================================================

/** Normalize raw UserMessage prompt from WS handler into a validated UserMessage */
function convertRawPromptToUserMessage(
	rawPrompt: any,
	senderId?: string,
	senderName?: string,
): UserMessage {
	const content: UserContentBlock[] = Array.isArray(rawPrompt?.content) && rawPrompt.content.length > 0
		? rawPrompt.content as UserContentBlock[]
		: [{ type: 'text', text: '' }];

	// Build engine object from raw prompt
	const rawEngine = rawPrompt?.engine;
	const engineObj = rawEngine && typeof rawEngine === 'object'
		? rawEngine
		: {
			type: rawEngine || 'claude-code',
			provider: '',
			model: {
				id: rawPrompt?.model?.id ?? rawPrompt?.modelId ?? '',
				name: rawPrompt?.model?.name ?? rawPrompt?.modelName ?? '',
			},
			account: { id: rawPrompt?.account?.id ?? 0, name: rawPrompt?.account?.name ?? '' },
		};

	return {
		type: 'user',
		createdAt: rawPrompt?.createdAt || new Date().toISOString(),
		messageId: rawPrompt?.messageId || rawPrompt?.id || crypto.randomUUID(),
		sessionId: null, // User messages from the frontend have no SDK session ID
		parent: {
			messageId: rawPrompt?.parent?.messageId ?? rawPrompt?.parentMessageId ?? null,
			sessionId: rawPrompt?.parent?.sessionId ?? rawPrompt?.parentSessionId ?? null,
			toolUseId: rawPrompt?.parent?.toolUseId ?? rawPrompt?.parentToolUseId ?? null,
		},
		engine: engineObj,
		sender: {
			id: senderId || rawPrompt?.sender?.id || '',
			name: senderName || rawPrompt?.sender?.name || '',
		},
		content,
		synthetic: rawPrompt?.synthetic ?? false,
	};
}

/** Request-level engine context injected into every SDK-emitted message */
interface RequestEngineContext {
	accountId: number;
	accountName: string;
	modelName: string;
}

/**
 * Enrich a message's engine block with request-level data that SDK adapters
 * cannot know (display-name for the selected account and the human-readable
 * model name). The adapter supplies type/provider/model.id; stream-manager
 * is the single source of truth for the rest.
 */
function enrichMessageEngine(
	message: UnifiedMessage,
	ctx: RequestEngineContext,
): UnifiedMessage {
	return {
		...message,
		engine: {
			...message.engine,
			model: {
				...message.engine.model,
				name: ctx.modelName || message.engine.model.name,
			},
			account: {
				id: ctx.accountId || message.engine.account.id,
				name: ctx.accountName || message.engine.account.name,
			},
		},
	};
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
	private emitStreamLifecycle(streamState: StreamState, status: 'completed' | 'error' | 'cancelled', reason?: string): void {
		if (this.lifecycleEmitted.has(streamState.streamId)) return;
		this.lifecycleEmitted.add(streamState.streamId);

		this.emit('stream:lifecycle', {
			status,
			streamId: streamState.streamId,
			projectId: streamState.projectId,
			chatSessionId: streamState.chatSessionId,
			timestamp: (streamState.completedAt || new Date()).toISOString(),
			reason
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
					if (request.engine.type === 'claude-code') {
						// Claude Code: cancel existing stream to prevent message loss from race condition.
						// Claude Code SDK only returns session_id inside yielded messages, so a cancelled
						// stream may never have established a valid session — safe to cancel and restart.
						debug.log('chat', `Cancelling existing active stream ${existingStreamId} before starting new one`);
						await this.cancelStream(existingStreamId);
					} else {
						// Other engines (OpenCode): return existing stream ID (original behavior).
						// OpenCode creates sessions synchronously, so the existing stream is valid.
						return existingStreamId;
					}
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
			engine: request.engine.type,
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
				sessionQueries.updateEngineModel(
					request.chatSessionId,
					request.engine.type,
					request.engine.provider,
					request.engine.model.id || DEFAULT_MODEL_ID,
					request.engine.model.name || DEFAULT_MODEL_NAME
				);
				if (request.engine.account.id) {
					sessionQueries.updateAccount(request.chatSessionId, request.engine.account.id, request.engine.account.name || null);
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

		// Attach engine type string to event data for frontend routing metadata
		// (stream-level metadata, distinct from message.engine which is the full MessageEngine object)
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
	 * Process stream in background — routes EngineOutput events by type discriminant
	 */
	private async processStream(streamState: StreamState, requestData: StreamRequest): Promise<void> {
		let userMessageId: string | undefined;

		if (requestData.projectPath && requestData.chatSessionId) {
			snapshotService.initializeSessionBaseline(
				requestData.projectPath,
				requestData.chatSessionId
			).catch(err => debug.error('snapshot', 'Failed to initialize session baseline:', err));
		}

		try {
			const { projectPath, prompt: rawPrompt, chatSessionId, engine: requestEngine, sender: requestSender } = requestData;

			// Engine context that stream-manager injects into every SDK-emitted message.
			// (SDK adapters cannot know these values; only the request layer can.)
			const engineCtx: RequestEngineContext = {
				accountId: requestEngine.account.id,
				accountName: requestEngine.account.name,
				modelName: requestEngine.model.name,
			};

			const projectPathExists = projectPath ? await this.existsSync(projectPath) : false;
			if (!projectPath) throw new Error('Project path is required. Please select a valid project directory.');
			if (!projectPathExists) throw new Error(`Project path does not exist: ${projectPath}. Please select a valid project directory.`);

			// Get resume session ID (branch-aware).
			// Primary: use parentSessionId carried by the UserMessage — set by the
			// frontend from the last assistant/reasoning sessionId in the current branch.
			// Fallback: walk the HEAD chain in the DB (handles messages sent from
			// older clients or tool-result user messages that lack parentSessionId).
			let resumeSessionId: string | undefined = undefined;
			if (chatSessionId) {
				// Primary source: parent.sessionId on the raw prompt
				const promptParentSessionId = rawPrompt?.parent?.sessionId;
				if (promptParentSessionId && promptParentSessionId !== chatSessionId) {
					resumeSessionId = promptParentSessionId;
				} else {
					// Fallback: walk HEAD chain
					try {
						const head = sessionQueries.getHead(chatSessionId);
						if (head) {
							const chain = messageQueries.getPathToRoot(head);
							for (let i = chain.length - 1; i >= 0; i--) {
								try {
									const msg = JSON.parse(chain[i].data) as UnifiedMessage;
									if (msg.type === 'user') continue;
									if (msg.sessionId && msg.sessionId !== chatSessionId) {
										resumeSessionId = msg.sessionId;
										break;
									}
								} catch { /* skip unparseable blobs */ }
							}
						}
					} catch (error) {
						debug.error('chat', 'Failed to get resume session ID from HEAD chain:', error);
					}
				}
			}
			streamState.preStreamSessionId = resumeSessionId ?? null;

			// Convert raw SDK prompt → UserMessage (unified)
			const userMessage = convertRawPromptToUserMessage(rawPrompt, requestSender.id, requestSender.name);

			// Save user message to DB
			const userMessageTimestamp = new Date().toISOString();
			const savedMessage = await this.saveMessage(
				userMessage,
				chatSessionId,
				userMessageTimestamp
			);
			userMessageId = savedMessage?.id;

			streamState.messages.push({
				processId: streamState.processId,
				message: userMessage as any,
				timestamp: userMessageTimestamp,
				message_id: savedMessage?.id,
				parent_message_id: savedMessage?.parent_message_id || null,
				sender_id: requestSender.id,
				sender_name: requestSender.name
			});

			this.emitStreamEvent(streamState, 'message', {
				processId: streamState.processId,
				message: userMessage,
				timestamp: userMessageTimestamp,
				message_id: savedMessage?.id,
				parent_message_id: savedMessage?.parent_message_id || null,
				sender_id: requestSender.id,
				sender_name: requestSender.name
			});

			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled after saving user message, skipping query');
				return;
			}

			let sdkSessionId: string | undefined;
			let lastAssistantTextContent: string | null = null;
			const projectId = streamState.projectId || 'default';

			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled before engine initialization, skipping query');
				return;
			}

			const engine = await initializeProjectEngine(projectId, requestEngine.type);

			if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
				debug.log('chat', 'Stream cancelled during engine initialization, skipping query');
				return;
			}

			// Detect orphaned user messages and prepend context (claude-code only)
			let enginePrompt = userMessage;
			if (requestEngine.type === 'claude-code' && chatSessionId) {
				try {
					const head = sessionQueries.getHead(chatSessionId);
					if (head) {
						const chain = messageQueries.getPathToRoot(head);
						const previousChain = chain.slice(0, -1);

						if (previousChain.length > 0) {
							let boundaryIndex = -1;
							if (resumeSessionId) {
								for (let i = previousChain.length - 1; i >= 0; i--) {
									try {
										const msg = JSON.parse(previousChain[i].data) as UnifiedMessage;
										if (msg.sessionId === resumeSessionId) {
											boundaryIndex = i;
											break;
										}
									} catch { /* skip unparseable */ }
								}
							}

							const orphanedUserTexts: string[] = [];
							for (let i = boundaryIndex + 1; i < previousChain.length; i++) {
								try {
									const msg = JSON.parse(previousChain[i].data) as UnifiedMessage;
									if (msg.type === 'user') {
											const text = msg.content
												.filter(block => block.type === 'text')
												.map(block => block.text)
												.join('\n');
											if (text.trim()) orphanedUserTexts.push(text.trim());
									}
								} catch { /* skip unparseable */ }
							}

							if (orphanedUserTexts.length > 0) {
								debug.log('chat', `Prepending ${orphanedUserTexts.length} orphaned user message(s) as context`);
								const contextPrefix = [
									'[Previous unprocessed messages from the user:]',
									...orphanedUserTexts.map((text, i) => `${i + 1}. "${text}"`),
									'',
									'[Current message:]'
								].join('\n');

								enginePrompt = {
									...userMessage,
									content: [
										{ type: 'text' as const, text: contextPrefix },
										...userMessage.content,
									],
								};
							}
						}
					}
				} catch (error) {
					debug.error('chat', 'Failed to detect orphaned messages:', error);
				}
			}

			// Stream EngineOutput events through the engine adapter
			const streamIterable = engine.streamQuery({
				projectPath,
				prompt: enginePrompt,
				resume: resumeSessionId,
				providerSlug: requestEngine.provider,
				modelId: requestEngine.model.id,
				includePartialMessages: true,
				abortController: streamState.abortController,
				...(requestEngine.account.id !== 0 && { accountId: requestEngine.account.id }),
				...(projectId && chatSessionId && {
					mcpContext: { projectId, chatSessionId, streamId: streamState.streamId }
				}),
			});

			await projectContextService.runWithContextAsync(
				{ chatSessionId, projectId, streamId: streamState.streamId },
				async () => { for await (const output of streamIterable) {
				if ((streamState.status as string) === 'cancelled' || streamState.abortController?.signal.aborted) {
					break;
				}

				// ── Route by type discriminant ──────────────────────────────

				// Extract session ID from first event that has one
				if (!sdkSessionId) {
					const eventSessionId = 'sessionId' in output ? (output as any).sessionId : null;
					if (eventSessionId) {
						sdkSessionId = eventSessionId;
						streamState.sdkSessionId = sdkSessionId;
						if (chatSessionId) {
							try { sessionQueries.updateSessionId(chatSessionId, sdkSessionId!); }
							catch { /* ignore */ }
						}
					}
				}

				switch (output.type) {
					// ── System Init ────────────────────────────────────────
					case 'system_init': {
						const initEvent = output as SystemInitEvent;
						const failedServers = initEvent.mcpServers.filter(s => s.status !== 'connected');
						failedServers.forEach(server => {
							debug.warn('mcp', `MCP server connection failed: ${server.name} (${server.status})`);
							this.emitStreamEvent(streamState, 'notification', {
								notification: {
									type: 'warning',
									title: 'MCP Server Connection Failed',
									message: `Failed to connect to custom MCP server "${server.name}". Status: ${server.status}`,
								},
								timestamp: new Date().toISOString()
							});
						});
						const connected = initEvent.mcpServers.filter(s => s.status === 'connected');
						if (connected.length > 0) {
							debug.log('mcp', `✓ Connected MCP servers: ${connected.map(s => s.name).join(', ')}`);
						}
						continue; // Don't save to DB
					}

					// ── Compact Boundary ───────────────────────────────────
					case 'compact_boundary': {
						const boundary = enrichMessageEngine(output, engineCtx) as CompactBoundaryMessage;
						streamState.hasCompactBoundary = true;
						const compactTimestamp = boundary.createdAt;

						let savedCompactId: string | undefined;
						let savedCompactParentId: string | null = null;
						if (chatSessionId) {
							const saved = await this.saveMessage(
								boundary,
								chatSessionId,
								compactTimestamp
							);
							savedCompactId = saved?.id;
							savedCompactParentId = saved?.parent_message_id || null;
						}

						streamState.messages.push({
							processId: streamState.processId,
							message: boundary as any,
							timestamp: compactTimestamp,
							message_id: savedCompactId,
							parent_message_id: savedCompactParentId,
							compactBoundary: {
								trigger: boundary.trigger,
								preTokens: boundary.preTokens
							}
						});

						this.emitStreamEvent(streamState, 'message', {
							processId: streamState.processId,
							message: boundary,
							timestamp: compactTimestamp,
							message_id: savedCompactId,
							parent_message_id: savedCompactParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});
						continue;
					}

					// ── Rate Limit ─────────────────────────────────────────
					case 'rate_limit': {
						const rl = output as RateLimitEvent;
						const isRejected = rl.status === 'rejected';
						const resetTime = rl.resetsAt
							? new Date(rl.resetsAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
							: 'unknown';
						this.emitStreamEvent(streamState, 'notification', {
							notification: {
								type: isRejected ? 'error' : 'warning',
								title: isRejected ? 'Rate Limit Reached' : 'Rate Limit Warning',
								message: isRejected
									? `Rate limit exceeded. Resets at ${resetTime}.`
									: `Approaching rate limit (${Math.round((rl.utilization || 0) * 100)}% used). Resets at ${resetTime}.`,
							},
							timestamp: new Date().toISOString()
						});
						continue;
					}

					// ── Result ─────────────────────────────────────────────
					case 'result': {
						if (output.subtype === 'success') {
							const successResult = output as SuccessResultEvent;
							// Backfill stopReason to last assistant message if SDK left it null
							if (successResult.stopReason && chatSessionId) {
								const mapped = this.backfillStopReason(chatSessionId, successResult.stopReason);
								// Re-emit patched assistant message so frontend updates live data
								if (mapped && streamState.currentMessage?.type === 'assistant' && !streamState.currentMessage.stopReason) {
									const patched = { ...streamState.currentMessage, stopReason: mapped } as AssistantMessage;
									streamState.currentMessage = patched;
									// Find the saved message ID from the last emitted assistant
									const lastEntry = [...streamState.messages].reverse()
										.find((m: any) => m.message?.type === 'assistant') as any;
									this.emitStreamEvent(streamState, 'message', {
										processId: streamState.processId,
										message: patched,
										timestamp: patched.createdAt,
										message_id: lastEntry?.message_id ?? undefined,
										parent_message_id: lastEntry?.parent_message_id ?? null,
										sender_id: requestSender.id,
										sender_name: requestSender.name
									});
								}
							}
						} else {
							const errResult = output as ErrorResultEvent;
							if (errResult.errors?.length) {
								debug.warn('chat', `SDK result error: ${errResult.subtype}`, errResult.errors);
							}
						}
						continue; // Don't save to DB
					}

					// ── Stream Events (deltas, start/stop) ────────────────
					case 'stream_event': {
						const streamEvt = output as UnifiedStreamEvent;

						if (streamEvt.event === 'start') {
							const lifecycle = streamEvt as StreamLifecycleEvent;
							if (lifecycle.reasoning) {
								streamState.currentReasoningText = '';
							} else {
								streamState.currentPartialText = '';
							}
							this.emitStreamEvent(streamState, 'partial', {
								processId: streamState.processId,
								eventType: 'start',
								partialText: '',
								deltaText: '',
								...(lifecycle.reasoning && { reasoning: true }),
								timestamp: new Date().toISOString()
							});
						} else if (streamEvt.event === 'delta') {
							const delta = streamEvt as TextDeltaEvent;
							if (delta.reasoning) {
								streamState.currentReasoningText = (streamState.currentReasoningText || '') + delta.text;
								this.emitStreamEvent(streamState, 'partial', {
									processId: streamState.processId,
									eventType: 'update',
									partialText: streamState.currentReasoningText,
									deltaText: delta.text,
									reasoning: true,
									timestamp: new Date().toISOString()
								});
							} else {
								streamState.currentPartialText = (streamState.currentPartialText || '') + delta.text;
								this.emitStreamEvent(streamState, 'partial', {
									processId: streamState.processId,
									eventType: 'update',
									partialText: streamState.currentPartialText,
									deltaText: delta.text,
									timestamp: new Date().toISOString()
								});
							}
						} else if (streamEvt.event === 'stop') {
							const lifecycle = streamEvt as StreamLifecycleEvent;
							if (lifecycle.reasoning && streamState.currentReasoningText) {
								this.emitStreamEvent(streamState, 'partial', {
									processId: streamState.processId,
									eventType: 'end',
									partialText: streamState.currentReasoningText,
									deltaText: '',
									reasoning: true,
									timestamp: new Date().toISOString()
								});
								streamState.currentReasoningText = '';
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

					// ── Reasoning Message ──────────────────────────────────
					case 'reasoning': {
						const reasoning = enrichMessageEngine(output, engineCtx) as ReasoningMessage;
						streamState.currentReasoningText = undefined;

						const reasoningTimestamp = reasoning.createdAt;
						let savedReasoningId: string | undefined;
						let savedReasoningParentId: string | null = null;
						if (chatSessionId) {
							const saved = await this.saveMessage(
								reasoning,
								chatSessionId,
								reasoningTimestamp
							);
							savedReasoningId = saved?.id;
							savedReasoningParentId = saved?.parent_message_id || null;
						}

						this.emitStreamEvent(streamState, 'message', {
							processId: streamState.processId,
							message: reasoning,
							timestamp: reasoningTimestamp,
							message_id: savedReasoningId,
							parent_message_id: savedReasoningParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});
						continue;
					}

					// ── Assistant Message ──────────────────────────────────
					case 'assistant': {
						const assistantMsg = enrichMessageEngine(output, engineCtx) as AssistantMessage;

						// Deduplicate consecutive identical assistant messages
						const currentText = assistantMsg.content
							.filter(c => c.type === 'text')
							.map(c => (c as any).text as string)
							.join('');
						if (currentText && currentText === lastAssistantTextContent) {
							debug.warn('chat', 'Skipping duplicate consecutive assistant message');
							continue;
						}
						if (currentText) lastAssistantTextContent = currentText;

						const usage = assistantMsg.usage;
						const messageTimestamp = assistantMsg.createdAt;

						let savedMsgId: string | undefined;
						let savedParentId: string | null = null;
						if (chatSessionId) {
							const saved = await this.saveMessage(
								assistantMsg,
								chatSessionId,
								messageTimestamp
							);
							savedMsgId = saved?.id;
							savedParentId = saved?.parent_message_id || null;
						}

						streamState.currentPartialText = undefined;

						streamState.messages.push({
							processId: streamState.processId,
							message: assistantMsg as any,
							usage: usage as any,
							timestamp: messageTimestamp,
							message_id: savedMsgId,
							parent_message_id: savedParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});

						streamState.currentMessage = assistantMsg;

						this.emitStreamEvent(streamState, 'message', {
							processId: streamState.processId,
							message: assistantMsg,
							usage,
							timestamp: messageTimestamp,
							message_id: savedMsgId,
							parent_message_id: savedParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});
						continue;
					}

					// ── User Message (tool results from SDK) ───────────────
					case 'user': {
						const userMsg = enrichMessageEngine(output, engineCtx) as UserMessage;
						lastAssistantTextContent = null; // Reset dedup tracker

						const messageTimestamp = userMsg.createdAt;
						let savedMsgId: string | undefined;
						let savedParentId: string | null = null;
						if (chatSessionId) {
							const saved = await this.saveMessage(
								userMsg,
								chatSessionId,
								messageTimestamp
							);
							savedMsgId = saved?.id;
							savedParentId = saved?.parent_message_id || null;
						}

						streamState.messages.push({
							processId: streamState.processId,
							message: userMsg as any,
							timestamp: messageTimestamp,
							message_id: savedMsgId,
							parent_message_id: savedParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});

						streamState.currentMessage = userMsg;

						this.emitStreamEvent(streamState, 'message', {
							processId: streamState.processId,
							message: userMsg,
							timestamp: messageTimestamp,
							message_id: savedMsgId,
							parent_message_id: savedParentId,
							sender_id: requestSender.id,
							sender_name: requestSender.name
						});
						continue;
					}

					default:
						debug.log('chat', `[SM] Skipping unknown EngineOutput type: ${(output as any).type}`);
						continue;
				}
			} }); // end runWithContextAsync + for await

			if (streamState.status === 'active') {
				streamState.status = 'completed';
				streamState.completedAt = new Date();

				this.emitStreamEvent(streamState, 'complete', {
					processId: streamState.processId,
					timestamp: streamState.completedAt.toISOString()
				});
				this.emitStreamLifecycle(streamState, 'completed');
			}

			if (chatSessionId) {
				browserMcpControl.releaseSession(chatSessionId);
				debug.log('mcp', `✅ Auto-released MCP tabs for session ${chatSessionId.slice(0, 8)} on stream completion`);
			}

		} catch (error) {
			if (streamState.status !== 'cancelled') {
				streamState.status = 'error';
				streamState.error = this.extractErrorDetail(error);
				streamState.completedAt = new Date();

				const errorTimestamp = streamState.completedAt.toISOString();

				// Build a synthetic error assistant message (unified type)
				const errorAssistantMsg: AssistantMessage = {
					type: 'assistant',
					createdAt: errorTimestamp,
					messageId: crypto.randomUUID(),
					sessionId: streamState.sdkSessionId || null,
					parent: { messageId: null, sessionId: null, toolUseId: null },
					engine: { type: streamState.engine, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
					content: [{ type: 'text', text: `**Error:** ${streamState.error}` }],
					stopReason: null,
					usage: null,
				};

				let savedErrorMsgId: string | undefined;
				let savedErrorParentId: string | null = null;
				if (requestData.chatSessionId) {
					const saved = await this.saveMessage(
						errorAssistantMsg,
						requestData.chatSessionId,
						errorTimestamp
					);
					savedErrorMsgId = saved?.id;
					savedErrorParentId = saved?.parent_message_id || null;
				}

				this.emitStreamEvent(streamState, 'message', {
					processId: streamState.processId,
					message: errorAssistantMsg,
					timestamp: errorTimestamp,
					message_id: savedErrorMsgId,
					parent_message_id: savedErrorParentId,
					sender_id: requestData.sender.id,
					sender_name: requestData.sender.name,
				});

				this.emitStreamEvent(streamState, 'error', {
					processId: streamState.processId,
					error: streamState.error,
					timestamp: errorTimestamp
				});

				this.emitStreamLifecycle(streamState, 'error');
			}

			if (requestData.chatSessionId) {
				browserMcpControl.releaseSession(requestData.chatSessionId);
				debug.log('mcp', `✅ Auto-released MCP tabs for session ${requestData.chatSessionId.slice(0, 8)} on stream error`);
			}
		} finally {
			const { projectPath, projectId, chatSessionId } = requestData;
			if (projectPath && projectId && chatSessionId && userMessageId) {
				snapshotService.captureSnapshot(projectPath, projectId, chatSessionId, userMessageId)
					.then(() => {
						debug.log('chat', `Stream-end snapshot captured for message: ${userMessageId}`);
						this.emit('snapshot:captured', { projectId, chatSessionId });
					})
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
	/**
	 * Resolve a pending AskUserQuestion for an active stream.
	 * Unblocks the engine's canUseTool callback so the SDK can continue.
	 */
	resolveUserAnswer(chatSessionId: string, projectId: string | undefined, toolUseId: string, answers: Record<string, string>): boolean {
		// Find the active stream for this session
		const sessionKey = this.getSessionKey(projectId, chatSessionId);
		const streamId = this.sessionStreams.get(sessionKey);
		if (!streamId) {
			debug.warn('chat', 'resolveUserAnswer: No stream found for session');
			return false;
		}

		const streamState = this.activeStreams.get(streamId);
		if (!streamState || streamState.status !== 'active') {
			debug.warn('chat', 'resolveUserAnswer: Stream not active');
			return false;
		}

		// Get the engine for this project
		const pid = streamState.projectId || 'default';
		const engine = getProjectEngine(pid, streamState.engine);

		if (!engine.resolveUserAnswer) {
			debug.warn('chat', 'resolveUserAnswer: Engine does not support resolveUserAnswer');
			return false;
		}

		debug.log('chat', 'Resolving AskUserQuestion answer:', { toolUseId, answers });
		return engine.resolveUserAnswer(toolUseId, answers);
	}

	async cancelStream(streamId: string, reason?: string): Promise<boolean> {
		const streamState = this.activeStreams.get(streamId);
		if (!streamState || streamState.status !== 'active') {
			return false;
		}

		// Mark as cancelled FIRST to prevent further message processing
		streamState.status = 'cancelled';
		streamState.completedAt = new Date();

		// Save partial reasoning text to DB before cancelling (persists across refresh/project switch)
		if (streamState.currentReasoningText && streamState.chatSessionId) {
			try {
				const timestamp = new Date().toISOString();
				const currentHead = sessionQueries.getHead(streamState.chatSessionId);

				const reasoningMessage: ReasoningMessage = {
					type: 'reasoning',
					createdAt: timestamp,
					messageId: crypto.randomUUID(),
					sessionId: null, // Partial cancel saves are not valid resume targets
					parent: { messageId: currentHead || null, sessionId: null, toolUseId: null },
					engine: { type: streamState.engine, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
					text: streamState.currentReasoningText,
				};

				const savedMessage = messageQueries.create({
					session_id: streamState.chatSessionId,
					message: reasoningMessage,
					timestamp,
					parent_message_id: currentHead || undefined
				});

				sessionQueries.updateHead(streamState.chatSessionId, savedMessage.id);
				sessionQueries.updateOnMessage(streamState.chatSessionId, {
					messageType: 'reasoning', timestamp,
				});
				debug.log('chat', 'Saved partial reasoning on cancel:', savedMessage.id);
			} catch (error) {
				debug.error('chat', 'Failed to save partial reasoning on cancel:', error);
			}
		}

		// Save partial text to DB before cancelling (persists across refresh/project switch)
		if (streamState.currentPartialText && streamState.chatSessionId) {
			try {
				const timestamp = new Date().toISOString();
				const currentHead = sessionQueries.getHead(streamState.chatSessionId);

				const partialMessage: AssistantMessage = {
					type: 'assistant',
					createdAt: timestamp,
					messageId: crypto.randomUUID(),
					sessionId: null, // Partial cancel saves are not valid resume targets
					parent: { messageId: currentHead || null, sessionId: null, toolUseId: null },
					engine: { type: streamState.engine, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
					content: [{ type: 'text', text: streamState.currentPartialText }],
					stopReason: 'interrupted',
					usage: null,
				};

				const savedMessage = messageQueries.create({
					session_id: streamState.chatSessionId,
					message: partialMessage,
					timestamp,
					parent_message_id: currentHead || undefined
				});

				sessionQueries.updateHead(streamState.chatSessionId, savedMessage.id);
				const clean = streamState.currentPartialText.replace(/```[\s\S]*?```/g, '').trim();
				sessionQueries.updateOnMessage(streamState.chatSessionId, {
					messageType: 'assistant', timestamp,
					headSummary: clean ? clean.slice(0, 200) + (clean.length > 200 ? '...' : '') : undefined,
				});
				debug.log('chat', 'Saved partial text on cancel:', savedMessage.id);
			} catch (error) {
				debug.error('chat', 'Failed to save partial text on cancel:', error);
			}
		}

		// Claude Code only: restore head_session_id to pre-stream value.
		// Claude Code SDK only returns session_id inside yielded messages, so a cancelled
		// stream's fork session_id is not a valid resume target. OpenCode creates sessions
		// synchronously, so its head_session_id is always valid — no restoration needed.
		if (streamState.engine === 'claude-code' && streamState.chatSessionId && streamState.preStreamSessionId !== undefined) {
			try {
				if (streamState.preStreamSessionId) {
					sessionQueries.updateSessionId(streamState.chatSessionId, streamState.preStreamSessionId);
				} else {
					sessionQueries.clearSessionId(streamState.chatSessionId);
				}
				debug.log('chat', `Restored head_session_id to: ${streamState.preStreamSessionId || 'null'}`);
			} catch (error) {
				debug.error('chat', 'Failed to restore head_session_id:', error);
			}
		}

		// Cancel the per-project engine with a bounded timeout.
		// engine.cancel() stops the SDK process (Claude Code: close() kills subprocess,
		// OpenCode: aborts controller + HTTP abort to server). If cancel() hangs
		// (e.g. unresponsive SDK), the timeout ensures we always proceed to emit
		// events and update presence — preventing infinite loader on the frontend.
		const projectId = streamState.projectId || 'default';
		try {
			const engine = getProjectEngine(projectId, streamState.engine);
			if (engine.isActive) {
				await Promise.race([
					engine.cancel(),
					new Promise<void>(resolve => setTimeout(resolve, 5000))
				]);
			}
		} catch (error) {
			debug.error('chat', 'Error cancelling engine (non-fatal):', error);
		}

		// Abort the stream-manager's controller as a fallback.
		// engine.cancel() already aborts the same controller, so this is
		// typically a no-op but ensures cleanup if the engine timed out
		// or wasn't active.
		if (!streamState.abortController?.signal.aborted) {
			streamState.abortController?.abort();
		}

		this.emitStreamEvent(streamState, 'cancelled', {
			processId: streamState.processId,
			timestamp: streamState.completedAt.toISOString()
		});

		this.emitStreamLifecycle(streamState, 'cancelled', reason);

		// Auto-release all MCP-controlled tabs for this chat session
		if (streamState.chatSessionId) {
			browserMcpControl.releaseSession(streamState.chatSessionId);
			debug.log('mcp', `✅ Auto-released MCP tabs for session ${streamState.chatSessionId.slice(0, 8)} on stream cancellation`);
		}

		return true;
	}

	/**
	 * Clean up a stream
	 */
	private cleanupStream(streamId: string): void {
		const streamState = this.activeStreams.get(streamId);
		if (streamState) {
			const sessionKey = this.getSessionKey(streamState.projectId, streamState.chatSessionId);
			// Only delete session key if it still points to THIS stream.
			// A newer stream for the same session may have overridden the key;
			// blindly deleting it would orphan the active stream — making it
			// unfindable by getSessionStream() and breaking cancel/reconnect.
			if (this.sessionStreams.get(sessionKey) === streamId) {
				this.sessionStreams.delete(sessionKey);
			}
			if (this.sessionStreams.get(streamState.chatSessionId) === streamId) {
				this.sessionStreams.delete(streamState.chatSessionId);
			}
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
	 * Save message to database and update session metadata.
	 */
	private async saveMessage(
		message: UnifiedMessage,
		sessionId: string,
		timestamp: string
	): Promise<DatabaseMessage | null> {
		try {
			const currentHead = sessionQueries.getHead(sessionId);

			const savedMessage = messageQueries.create({
				session_id: sessionId,
				message: message,
				timestamp,
				parent_message_id: currentHead || undefined
			});

			sessionQueries.updateHead(sessionId, savedMessage.id);

			// ── Update session metadata ──
			try {
				const text = extractMessageText(message);
				const updateOpts: Parameters<typeof sessionQueries.updateOnMessage>[1] = {
					messageType: message.type,
					senderId: message.type === 'user' ? message.sender?.id : undefined,
					senderName: message.type === 'user' ? message.sender?.name : undefined,
					timestamp,
				};

				if (message.type === 'user' && text.trim()) {
					updateOpts.headTitle = text.slice(0, 80) + (text.length > 80 ? '...' : '');
					// Auto-set title if this is the first user message
					if (!currentHead) {
						updateOpts.isFirstUserMessage = true;
						updateOpts.title = updateOpts.headTitle;
					}
				} else if (message.type === 'assistant' && text.trim()) {
					const clean = text.replace(/```[\s\S]*?```/g, '').trim();
					if (clean) {
						updateOpts.headSummary = clean.slice(0, 200) + (clean.length > 200 ? '...' : '');
					}
				}

				sessionQueries.updateOnMessage(sessionId, updateOpts);
			} catch (err) {
				debug.error('chat', 'Failed to update session metadata:', err);
			}

			// Update checkpoint_tree_state when saving a new checkpoint (real user message)
			if (message.type === 'user') {
				try {
					const { isCheckpointMessage, buildCheckpointTree, getCheckpointPathToRoot } = await import('../snapshot/helpers');
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
	 * Backfill stopReason from a result event to the last assistant message in DB.
	 * Claude Code SDK may yield assistant messages with stop_reason: null during streaming;
	 * the actual stop_reason only arrives in the result event after the turn completes.
	 * Returns the mapped StopReason if backfill succeeded, null otherwise.
	 */
	private backfillStopReason(chatSessionId: string, rawStopReason: string): StopReason | null {
		try {
			const mapped: StopReason = (['end_turn', 'tool_use', 'max_tokens', 'interrupted'] as StopReason[])
				.find(r => r === rawStopReason) || 'end_turn';

			const currentHead = sessionQueries.getHead(chatSessionId);
			if (!currentHead) return null;

			const headRow = messageQueries.getById(currentHead);
			if (!headRow) return null;

			const headMsg = JSON.parse(headRow.data) as UnifiedMessage;
			if (headMsg.type !== 'assistant' || headMsg.stopReason) return null;

			const updated = { ...headMsg, stopReason: mapped };
			const { getDatabase } = require('../database');
			getDatabase().prepare('UPDATE messages SET data = ? WHERE id = ?')
				.run(JSON.stringify(updated), headRow.id);

			return mapped;
		} catch (err) {
			debug.error('chat', 'Failed to backfill stopReason:', err);
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
	 * Cancel and clean up all streams for a specific chat session.
	 * Used when a session is deleted to remove green/amber status indicators.
	 */
	async cleanupSessionStreams(chatSessionId: string): Promise<void> {
		const streamsToCancel: string[] = [];
		const streamsToClean: string[] = [];

		this.activeStreams.forEach((stream, streamId) => {
			if (stream.chatSessionId === chatSessionId) {
				if (stream.status === 'active') {
					streamsToCancel.push(streamId);
				} else {
					streamsToClean.push(streamId);
				}
			}
		});

		// Cancel active streams and await their processStream promise so the
		// finally block (snapshot capture) completes before the caller deletes
		// the session — preventing FOREIGN KEY constraint failures.
		for (const streamId of streamsToCancel) {
			await this.cancelStream(streamId, 'session-deleted');
			const stream = this.activeStreams.get(streamId);
			if (stream?.streamPromise) {
				await stream.streamPromise.catch(() => {});
			}
		}

		// Clean up non-active streams
		for (const streamId of streamsToClean) {
			this.cleanupStream(streamId);
		}
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
