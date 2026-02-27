/**
 * Open Code Engine Adapter
 *
 * Wraps the @opencode-ai/sdk into the AIEngine interface.
 * Converts Open Code messages/events → SDKMessage (Claude format)
 * so stream-manager and frontend remain unchanged.
 *
 * Server lifecycle is managed by ./server.ts (bun-pty spawn).
 * This file only contains the OpenCodeEngine class (per-project instance).
 */

import type { SDKMessage, SDKUserMessage, EngineSDKMessage } from '$shared/types/messaging';
import type { AIEngine, EngineQueryOptions } from '../../types';
import type { EngineModel } from '$shared/types/engine';
import type {
	Provider,
	Model,
	EventMessageUpdated,
	EventMessagePartUpdated,
	EventSessionIdle,
	EventSessionStatus,
	EventSessionError,
	Part,
	ToolPart,
	Message as OCMessage,
} from '@opencode-ai/sdk';
import {
	convertAssistantMessages,
	convertResultMessage,
	convertSystemInitMessage,
	convertStreamStart,
	convertPartialTextDelta,
	convertStreamStop,
	convertToolUseOnly,
	convertToolResultOnly,
	convertReasoningMessage,
	convertPartialReasoningDelta,
	convertReasoningStreamStart,
	convertReasoningStreamStop,
	getToolInput,
} from './message-converter';
import { ensureClient, getClient } from './server';
import { debug } from '$shared/utils/logger';

/** Map SDK Model.status to our category */
function mapStatusToCategory(status: Model['status']): EngineModel['category'] {
	switch (status) {
		case 'deprecated': return 'legacy';
		case 'alpha':
		case 'beta': return 'stable';
		default: return 'latest';
	}
}

/** Build capability tags from SDK Model.capabilities */
function buildCapabilityTags(model: Model): string[] {
	const tags: string[] = [];
	const caps = model.capabilities;

	if (caps.reasoning) tags.push('Reasoning');
	if (caps.attachment) tags.push('Attachments');

	return tags;
}

// ============================================================================
// OpenCode Engine (per-project instance)
// ============================================================================

export class OpenCodeEngine implements AIEngine {
	readonly name = 'opencode' as const;
	private _isInitialized = false;
	private _isActive = false;
	private activeAbortController: AbortController | null = null;
	private activeSessionId: string | null = null;
	private activeProjectPath: string | null = null;

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	get isActive(): boolean {
		return this._isActive;
	}

	/**
	 * Initialize this per-project engine instance.
	 * Delegates to the shared client singleton (concurrency-safe).
	 */
	async initialize(): Promise<void> {
		if (this._isInitialized) return;

		await ensureClient();
		this._isInitialized = true;
		debug.log('engine', 'Open Code engine instance initialized (shared client)');
	}

	/**
	 * Cleanup this per-project instance.
	 * Does NOT dispose the shared client — that's handled by disposeOpenCodeClient().
	 */
	async dispose(): Promise<void> {
		await this.cancel();
		this._isInitialized = false;
		debug.log('engine', 'Open Code engine instance disposed');
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		const client = await ensureClient();

		try {
			// config.providers() returns { data: { providers: Provider[] } }
			const response = await client.config.providers();
			const providers: Provider[] = response.data?.providers ?? [];
			const models: EngineModel[] = [];

			for (const provider of providers) {
				// Provider.models is Record<string, Model>
				const providerModels: Record<string, Model> = provider.models ?? {};

				for (const [modelKey, model] of Object.entries(providerModels)) {
					const modelId = model.id || modelKey;
					const compoundId = `opencode:${provider.id}/${modelId}`;

					models.push({
						id: compoundId,
						engine: 'opencode',
						modelId: `${provider.id}/${modelId}`,
						name: model.name || modelId,
						provider: provider.id,
						description: `${model.name || modelId} via ${provider.name || provider.id}`,
						capabilities: buildCapabilityTags(model),
						contextWindow: model.limit.context,
						category: mapStatusToCategory(model.status),
					});
				}
			}

			debug.log('engine', `Fetched ${models.length} models from ${providers.length} Open Code providers`);
			return models;
		} catch (error) {
			debug.error('engine', 'Failed to fetch Open Code providers:', error);
		}

		return [];
	}

	/**
	 * Stream a query through Open Code SDK, yielding SDKMessage (Claude format)
	 *
	 * Flow: subscribe to events FIRST, then send prompt asynchronously.
	 * This ensures no events are missed between sending and subscribing.
	 */
	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineSDKMessage, void, unknown> {
		const client = await ensureClient();

		const {
			projectPath,
			prompt,
			resume,
			model = 'claude-sonnet',
			abortController
		} = options;

		this.activeAbortController = abortController || new AbortController();
		this._isActive = true;
		this.activeProjectPath = projectPath;

		debug.log('chat', 'Open Code - Stream Query');
		debug.log('chat', { prompt });

		try {
			const promptParts = this.extractPromptParts(prompt);

			// Create or fork a session
			// When resuming, fork the session to create a new branch
			// (like Claude Code's forkSession: true) so each checkpoint
			// gets its own conversation branch
			let sessionId: string;

			if (resume) {
				try {
					const forkResult = await client.session.fork({
						path: { id: resume },
						query: { directory: projectPath }
					});
					sessionId = forkResult.data?.id || resume;
					debug.log('engine', `Forked Open Code session: ${resume} → ${sessionId}`);
				} catch (forkError) {
					// Fallback to resuming the same session if fork fails
					debug.warn('engine', 'Failed to fork Open Code session, falling back to resume:', forkError);
					sessionId = resume;
				}
			} else {
				const sessionResult = await client.session.create({
					query: { directory: projectPath }
				});
				sessionId = sessionResult.data?.id || crypto.randomUUID();
			}

			this.activeSessionId = sessionId;

			yield convertSystemInitMessage(sessionId, model);
			yield convertStreamStart(sessionId);

			// 1. Subscribe to event stream FIRST (before sending prompt)
			const eventResult = await client.event.subscribe({
				query: { directory: projectPath },
				signal: this.activeAbortController.signal
			});

			// 2. Send prompt asynchronously (non-blocking) — parse "providerId/modelId"
			const [providerID, modelID] = model.includes('/') ? model.split('/', 2) : ['', model];

			client.session.promptAsync({
				path: { id: sessionId },
				body: {
					parts: promptParts as any,
					...(providerID && modelID ? { model: { providerID, modelID } } : {}),
				},
				query: { directory: projectPath },
			}).catch(error => {
				debug.error('engine', 'Open Code promptAsync error:', error);
			});

			// 3. Process event stream — emit messages progressively (like Claude Code)
			// Each assistant message becomes its own bubble in the UI
			const messageParts = new Map<string, Part[]>();
			const assistantMessages = new Map<string, OCMessage>(); // All tracked assistant messages
			const emittedMessageIds = new Set<string>(); // Already yielded message IDs
			let currentAssistantId: string | null = null; // Currently active assistant message
			let streamingText = '';
			const emittedToolParts = new Set<string>(); // Tool parts already emitted as tool_use
			const completedToolParts = new Set<string>(); // Tool parts whose tool_result was emitted
			const emittedReasoningParts = new Set<string>(); // Reasoning parts already flushed
			let reasoningStreamActive = false; // Whether reasoning is currently streaming
			let reasoningText = ''; // Accumulated reasoning text

			/**
			 * Flush active reasoning stream: stop reasoning stream, emit final reasoning message.
			 */
			const flushReasoning = function* (msg: OCMessage) {
				if (!reasoningStreamActive) return;
				yield convertReasoningStreamStop(sessionId);
				reasoningStreamActive = false;
				if (reasoningText) {
					yield convertReasoningMessage(reasoningText, msg, sessionId);
				}
				reasoningText = '';
			};

			/**
			 * Finalize and yield an assistant message by ID
			 * Emits stop stream event, the assembled message, and restarts stream for next message
			 */
			const finalizeMessage = function* (msgId: string) {
				const msg = assistantMessages.get(msgId);
				if (!msg || emittedMessageIds.has(msgId)) return;

				// Flush any active reasoning before finalizing
				yield* flushReasoning(msg);

				emittedMessageIds.add(msgId);

				// Stop current stream
				yield convertStreamStop(sessionId);

				const parts = messageParts.get(msgId) || [];
				// Filter out tool parts and reasoning parts already emitted
				const remainingParts = parts.filter(p => {
					if (p.type === 'tool') return !emittedToolParts.has(p.id);
					if (p.type === 'reasoning') return false; // Already emitted as reasoning message
					return true;
				});

				if (remainingParts.length > 0) {
					const splitMessages = convertAssistantMessages(msg, remainingParts, sessionId);
					for (const m of splitMessages) {
						yield m;
					}
				}

				// Restart stream for the next message
				yield convertStreamStart(sessionId);

				// Reset streaming text for new message
				streamingText = '';
			};

			// Track whether message.part.delta events are being received.
			// When active, skip delta processing in message.part.updated to prevent duplication.
			let receivedPartDelta = false;

			if (eventResult?.stream) {
				for await (const event of eventResult.stream) {
					if (this.activeAbortController?.signal.aborted) break;

					const evt = event as { type: string; properties: Record<string, unknown> };
					debug.log('engine', `[OC] event: ${evt.type}`);

					switch (evt.type) {
						case 'message.updated': {
							const { info } = (event as EventMessageUpdated).properties;
							// Only track assistant messages for our session
							if (info.role === 'assistant' && info.sessionID === sessionId) {
								assistantMessages.set(info.id, info);

								// If a NEW assistant message arrives and we had a previous one,
								// finalize the previous message (emit it as a separate bubble)
								if (currentAssistantId && currentAssistantId !== info.id) {
									yield* finalizeMessage(currentAssistantId);
								}
								currentAssistantId = info.id;
							}
							break;
						}

						case 'message.part.updated': {
							const props = (event as EventMessagePartUpdated).properties;
							const part = props.part;

							debug.log('engine', `[OC] part.updated: type=${part.type}, partId=${part.id}, msgId=${part.messageID}, session=${part.sessionID === sessionId ? 'match' : 'skip'}`);

							// Only process parts belonging to our session
							if (part.sessionID !== sessionId) break;

							// Only process parts for tracked assistant messages (skip user message parts)
							if (!assistantMessages.has(part.messageID)) {
								debug.log('engine', `[OC] part.updated: skipped — messageID not in assistantMessages`);
								break;
							}

							// Accumulate parts per message
							const msgId = part.messageID;
							if (!messageParts.has(msgId)) {
								messageParts.set(msgId, []);
							}

							const parts = messageParts.get(msgId)!;
							const existingIdx = parts.findIndex(p => p.id === part.id);
							if (existingIdx >= 0) {
								parts[existingIdx] = part;
							} else {
								parts.push(part);
							}

							// Progressive tool rendering: emit tool_use immediately, tool_result when done
							if (part.type === 'tool') {
								const toolPart = part as ToolPart;
								const msg = assistantMessages.get(msgId);

								// Flush reasoning before tool rendering to preserve order
								if (msg && reasoningStreamActive) {
									yield* flushReasoning(msg);
								}

								if (msg && !emittedToolParts.has(part.id)) {
									// Only emit tool_use when input is available
									// Pending tools may have empty input ({}) — wait for next update
									const resolvedInput = getToolInput(toolPart);
									const hasInput = Object.keys(resolvedInput).length > 0
										|| toolPart.state.status !== 'pending';

									if (hasInput) {
										emittedToolParts.add(part.id);

										yield convertStreamStop(sessionId);
										yield convertToolUseOnly(toolPart, msg, sessionId);

										// If already completed on first sight, emit result immediately too
										if (toolPart.state.status === 'completed' || toolPart.state.status === 'error') {
											completedToolParts.add(part.id);
											yield convertToolResultOnly(toolPart, sessionId);
										}

										yield convertStreamStart(sessionId);
										streamingText = '';
									}
								} else if (
									(toolPart.state.status === 'completed' || toolPart.state.status === 'error')
									&& !completedToolParts.has(part.id)
								) {
									// Tool completed later — emit tool_result
									completedToolParts.add(part.id);

									yield convertStreamStop(sessionId);
									yield convertToolResultOnly(toolPart, sessionId);
									yield convertStreamStart(sessionId);
									streamingText = '';
								}

								break;
							}

							// Handle reasoning parts — start reasoning stream (only once per part)
							if (part.type === 'reasoning') {
								if (!reasoningStreamActive && !emittedReasoningParts.has(part.id)) {
									reasoningStreamActive = true;
									reasoningText = '';
									emittedReasoningParts.add(part.id);
									yield convertReasoningStreamStart(sessionId);
									debug.log('engine', `[OC] reasoning stream started for part=${part.id}`);
								}
								break;
							}

							// When a text part appears and reasoning was active, flush reasoning first
							if (part.type === 'text' && reasoningStreamActive) {
								const msg = assistantMessages.get(msgId);
								if (msg) {
									yield* flushReasoning(msg);
								}
							}

							// Skip non-text/non-reasoning parts (step-start, step-finish, etc.)
							if (part.type !== 'text') {
								debug.log('engine', `[OC] part.updated: skipped non-text type=${part.type}`);
								break;
							}

							// Only stream text for the current active message
							if (msgId !== currentAssistantId) {
								debug.log('engine', `[OC] part.updated: text skipped — msgId=${msgId} !== currentAssistantId=${currentAssistantId}`);
								break;
							}

							// Stream text deltas — skip if message.part.delta events handle it
							// to prevent double-counting the same delta
							if (receivedPartDelta) {
								// message.part.delta handles text streaming — just update accumulated text
								if ((part as any).text) {
									// Sync streamingText with the authoritative accumulated text from the part
									// This handles any drift without emitting duplicate deltas
									streamingText = (part as any).text;
								}
								break;
							}

							const hasDelta = !!(props as any).delta;
							const hasText = !!(part as any).text;
							debug.log('engine', `[OC] text streaming: hasDelta=${hasDelta}, hasText=${hasText}, textLen=${(part as any).text?.length || 0}, streamingTextLen=${streamingText.length}`);

							if ((props as any).delta) {
								streamingText += (props as any).delta;
								yield convertPartialTextDelta((props as any).delta, sessionId);
							} else if ((part as any).text) {
								const newText = (part as any).text;
								if (newText.length > streamingText.length) {
									const diff = newText.slice(streamingText.length);
									streamingText = newText;
									yield convertPartialTextDelta(diff, sessionId);
								}
							}
							break;
						}

						case 'session.idle': {
							// Session finished — flush reasoning and emit the last assistant message
							if (currentAssistantId && !emittedMessageIds.has(currentAssistantId)) {
								const msg = assistantMessages.get(currentAssistantId);
								if (msg) {
									// Flush any active reasoning
									yield* flushReasoning(msg);
								}
								yield convertStreamStop(sessionId);
								if (msg) {
									const parts = messageParts.get(currentAssistantId) || [];
									// Filter out tool parts and reasoning parts already emitted
									const remainingParts = parts.filter(p => {
										if (p.type === 'tool') return !emittedToolParts.has(p.id);
										if (p.type === 'reasoning') return false;
										return true;
									});
									if (remainingParts.length > 0) {
										const splitMsgs1 = convertAssistantMessages(msg, remainingParts, sessionId);
										for (const m of splitMsgs1) {
											yield m;
										}
									}
								}
								emittedMessageIds.add(currentAssistantId);
							} else {
								yield convertStreamStop(sessionId);
							}

							// Emit result message with token usage from the last assistant message
							if (currentAssistantId) {
								const lastMsg = assistantMessages.get(currentAssistantId);
								if (lastMsg && lastMsg.role === 'assistant') {
									yield convertResultMessage(lastMsg, sessionId);
								}
							}

							return; // Done
						}

						case 'session.status': {
							const { status } = (event as EventSessionStatus).properties;
							if (status.type === 'idle') {
								// Same as session.idle
								if (currentAssistantId && !emittedMessageIds.has(currentAssistantId)) {
									const msg = assistantMessages.get(currentAssistantId);
									if (msg) {
										yield* flushReasoning(msg);
									}
									yield convertStreamStop(sessionId);
									if (msg) {
										const parts = messageParts.get(currentAssistantId) || [];
										const remainingParts = parts.filter(p => {
											if (p.type === 'tool') return !emittedToolParts.has(p.id);
											if (p.type === 'reasoning') return false;
											return true;
										});
										if (remainingParts.length > 0) {
											const splitMsgs2 = convertAssistantMessages(msg, remainingParts, sessionId);
											for (const m of splitMsgs2) {
												yield m;
											}
										}
									}
								} else {
									yield convertStreamStop(sessionId);
								}
								return;
							}
							break;
						}

						// Handle message.part.delta — newer OpenCode servers send text deltas
						// through this event instead of (or alongside) message.part.updated
						// When both fire for the same text, only this handler processes deltas
						case 'message.part.delta': {
							receivedPartDelta = true;
							const deltaProps = evt.properties as {
								sessionID?: string;
								messageID?: string;
								partID?: string;
								field?: string;
								delta?: string;
							};

							// Only process deltas for our session
							if (deltaProps.sessionID !== sessionId) break;
							// Only process deltas for tracked assistant messages
							if (!deltaProps.messageID || !assistantMessages.has(deltaProps.messageID)) break;
							// Only stream for the current active message
							if (deltaProps.messageID !== currentAssistantId) break;
							// Only stream text field deltas
							if (deltaProps.field !== 'text') break;

							// Handle reasoning part deltas — stream as reasoning instead of text
							if (deltaProps.partID && deltaProps.messageID && messageParts.has(deltaProps.messageID)) {
								const knownParts = messageParts.get(deltaProps.messageID)!;
								const knownPart = knownParts.find(p => p.id === deltaProps.partID);
								if (knownPart && knownPart.type === 'reasoning') {
									if (deltaProps.delta) {
										reasoningText += deltaProps.delta;
										yield convertPartialReasoningDelta(deltaProps.delta, sessionId);
									}
									break;
								}
								// Skip other non-text parts (step-start, etc.)
								if (knownPart && knownPart.type !== 'text') {
									break;
								}
							}

							if (deltaProps.delta) {
								debug.log('engine', `[OC] part.delta: field=${deltaProps.field}, deltaLen=${deltaProps.delta.length}`);
								streamingText += deltaProps.delta;

								// Also update the accumulated text in the tracked part
								if (deltaProps.partID && messageParts.has(deltaProps.messageID)) {
									const existingParts = messageParts.get(deltaProps.messageID)!;
									const textPart = existingParts.find(p => p.id === deltaProps.partID && p.type === 'text');
									if (textPart && 'text' in textPart) {
										(textPart as any).text = (textPart as any).text + deltaProps.delta;
									}
								}

								yield convertPartialTextDelta(deltaProps.delta, sessionId);
							}
							break;
						}

						case 'session.error': {
							const { error } = (event as EventSessionError).properties;
							// Extract a human-readable error message.
							// OpenCode SDK errors follow: { name: string, data: { message, statusCode?, providerID?, responseBody? } }
							// Don't prepend error class names (e.g. "APIError") — those are SDK
							// implementation details, not useful for the end user.
							let errorMsg = 'Unknown Open Code error';
							if (error) {
								const errObj = error as Record<string, any>;
								const name = errObj.name || '';
								const dataMsg = errObj.data?.message || '';
								const statusCode = errObj.data?.statusCode;
								const providerID = errObj.data?.providerID;
								const responseBody = errObj.data?.responseBody;

								if (dataMsg) {
									errorMsg = dataMsg;
								} else if (responseBody) {
									// No data.message — try to parse responseBody for the actual error
									try {
										const body = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
										errorMsg = body?.error?.message || body?.message || String(responseBody);
									} catch {
										errorMsg = String(responseBody);
									}
								} else if (name) {
									errorMsg = name;
								} else if (typeof error === 'string') {
									errorMsg = error;
								} else {
									errorMsg = JSON.stringify(error);
								}

								// Append status code
								if (statusCode) {
									errorMsg += ` (status ${statusCode})`;
								}

								// Append provider ID to help identify which provider failed
								if (providerID) {
									errorMsg += ` [provider: ${providerID}]`;
								}
							}
							debug.error('engine', '[OC] session.error:', errorMsg);
							throw new Error(errorMsg);
						}
					}
				}
			}

		} catch (error) {
			if (error instanceof Error) {
				if (error.name === 'AbortError' || error.message.includes('aborted')) {
					return;
				}
			}
			throw error;
		} finally {
			this._isActive = false;
			this.activeAbortController = null;
			this.activeSessionId = null;
			this.activeProjectPath = null;
		}
	}

	async cancel(): Promise<void> {
		// Abort the OpenCode session on the server so it stops processing
		const client = getClient();
		if (client && this.activeSessionId) {
			try {
				await client.session.abort({
					path: { id: this.activeSessionId },
					...(this.activeProjectPath && { query: { directory: this.activeProjectPath } }),
				});
				debug.log('engine', 'Open Code session aborted:', this.activeSessionId);
			} catch (error) {
				debug.warn('engine', 'Failed to abort Open Code session:', error);
			}
		}

		if (this.activeAbortController) {
			this.activeAbortController.abort();
			this.activeAbortController = null;
		}
		this._isActive = false;
		this.activeSessionId = null;
		this.activeProjectPath = null;
	}

	/**
	 * Cancel a specific session on the OpenCode server.
	 * Used by stream-manager for per-project isolation (instead of global cancel).
	 */
	async cancelSession(sessionId: string, projectPath?: string): Promise<void> {
		const client = getClient();
		if (!client || !sessionId) return;
		try {
			await client.session.abort({
				path: { id: sessionId },
				...(projectPath && { query: { directory: projectPath } }),
			});
			debug.log('engine', 'Open Code session aborted (per-stream):', sessionId);
		} catch (error) {
			debug.warn('engine', 'Failed to abort Open Code session:', error);
		}
	}

	async interrupt(): Promise<void> {
		// Open Code SDK doesn't have a separate interrupt — use cancel
		await this.cancel();
	}

	/**
	 * Extract prompt parts (text + file attachments) from SDKUserMessage.
	 * Converts Claude-format image/document blocks to OpenCode FilePartInput format.
	 */
	private extractPromptParts(prompt: SDKUserMessage): Array<
		| { type: 'text'; text: string }
		| { type: 'file'; mime: string; filename?: string; url: string }
	> {
		const msg = prompt as Record<string, unknown>;
		const message = msg.message as Record<string, unknown> | undefined;
		if (!message) return [{ type: 'text', text: '' }];

		if (typeof message.content === 'string') {
			return [{ type: 'text', text: message.content }];
		}

		if (Array.isArray(message.content)) {
			const parts: Array<
				| { type: 'text'; text: string }
				| { type: 'file'; mime: string; filename?: string; url: string }
			> = [];

			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block.type === 'text') {
					parts.push({ type: 'text', text: block.text as string });
				} else if (block.type === 'image' && block.source) {
					// Claude format: { type: 'image', source: { type: 'base64', media_type, data } }
					const source = block.source as Record<string, unknown>;
					if (source.type === 'base64' && source.data && source.media_type) {
						parts.push({
							type: 'file',
							mime: source.media_type as string,
							url: `data:${source.media_type};base64,${source.data}`,
						});
					}
				} else if (block.type === 'document' && block.source) {
					// Claude format: { type: 'document', source: { type: 'base64', media_type, data }, title }
					const source = block.source as Record<string, unknown>;
					if (source.type === 'base64' && source.data && source.media_type) {
						parts.push({
							type: 'file',
							mime: source.media_type as string,
							filename: (block.title as string) || undefined,
							url: `data:${source.media_type};base64,${source.data}`,
						});
					}
				}
			}

			if (parts.length === 0) {
				parts.push({ type: 'text', text: '' });
			}
			return parts;
		}

		return [{ type: 'text', text: '' }];
	}
}
