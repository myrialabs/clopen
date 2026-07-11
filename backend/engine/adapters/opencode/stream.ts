/**
 * Open Code Engine Adapter
 *
 * Wraps the @opencode-ai/sdk into the AIEngine interface.
 * Converts Open Code messages/events → EngineOutput (unified types)
 * so stream-manager and frontend remain engine-agnostic.
 *
 * Server lifecycle is managed by ./server.ts (Bun.spawn).
 * This file only contains the OpenCodeEngine class (per-project instance).
 */

import type { EngineOutput, UserMessage } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import type { EngineModel } from '$shared/types/unified';
import type {
	EventMessageUpdated,
	EventMessagePartUpdated,
	EventSessionIdle,
	EventSessionStatus,
	EventSessionError,
	Part,
	ToolPart,
	Message as OCMessage,
} from '@opencode-ai/sdk';
import { fetchOpenCodeModels } from './models';
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
	convertSubtaskToolUseOnly,
	getToolInput,
	mapToolName,
	TOOL_NAME_MAP,
} from './message-converter';
import { ensureClient, ensureServer, hashConfig, getClient, getServerUrl, type ServerInstance } from './server';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts, buildArtifactsPromptContext } from '$backend/engine/artifact-sync';
import { artifactFilter } from '$backend/profiles';
import { buildOpenCodeInlineAgents } from '$backend/subagents';
import { getOpenCodeProfileDisabledToolIds } from '$backend/mcp';
import { resolvePermissionsFromDb, matchesAny, type ResolvedPermissions } from '$backend/permissions';
import { formatSessionError, handleStreamError } from './error-handler';
import { buildJsonPrompt, extractJson } from '../../structured-helpers';
import { debug } from '$shared/utils/logger';

/**
 * Whether a permission policy blocks an OpenCode tool. Matched under BOTH the
 * raw OpenCode tool id (e.g. `bash`) and its canonical `mapToolName` form (e.g.
 * `Bash`, `mcp__server__tool`), so a rule written in either naming takes effect.
 * Deny wins; a non-empty allowlist blocks anything not matched under either name.
 */
function isOpenCodeToolBlocked(permissions: ResolvedPermissions, rawTool: string): boolean {
	const names = Array.from(new Set([rawTool, mapToolName(rawTool)].filter(Boolean)));
	if (names.some(n => matchesAny(permissions.deny, n))) return true;
	if (permissions.allow.length > 0 && !names.some(n => matchesAny(permissions.allow, n))) return true;
	return false;
}

/**
 * Per-prompt tool disable map (`{ toolId: false }`) enforcing the resolved
 * permission policy UP FRONT — OpenCode's `permission.asked` event only fires for
 * a subset of built-in tools (edit/bash/webfetch/…), never for read-only or MCP
 * tools, so a deny on those would otherwise be silently ignored (this is exactly
 * why a profile's MCP-tool deny worked on Claude's `canUseTool` but not here).
 * Passing the blocked tools as disabled removes them from the model's toolset
 * entirely — the OpenCode analogue of Claude/Qwen `excludeTools`.
 *
 * Coverage: every known built-in tool id plus each EXACT `mcp__<ns>__<tool>` deny
 * (mapped to OpenCode's `<ns>_<tool>` id). Wildcard MCP denies and allowlist-vs-
 * MCP remain best-effort (the full live MCP tool list isn't known synchronously
 * here) and still fall back to the bridge / permission.asked path.
 */
function buildOpenCodeToolDisableMap(permissions: ResolvedPermissions): Record<string, boolean> {
	const disable: Record<string, boolean> = {};
	// Built-in tools: test every OpenCode tool id we know the canonical name for.
	for (const rawTool of Object.keys(TOOL_NAME_MAP)) {
		if (isOpenCodeToolBlocked(permissions, rawTool)) disable[rawTool] = false;
	}
	// Exact MCP-tool denies → OpenCode's underscore-joined id (`<ns>_<tool>`).
	for (const pattern of permissions.deny) {
		if (pattern.endsWith('*')) continue;
		const m = /^mcp__(.+?)__(.+)$/.exec(pattern);
		if (m) disable[`${m[1]}_${m[2]}`] = false;
	}
	return disable;
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
	/** The pooled per-Profile server this instance's active stream is bound to. */
	private activeServer: ServerInstance | null = null;
	/** Pending question requests keyed by tool callID → { requestId, questions } */
	private pendingQuestions = new Map<string, { requestId: string; questions: Array<{ question: string }> }>();

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
		this.pendingQuestions.clear();
		this.activeServer = null;
		this._isInitialized = false;
		debug.log('engine', 'Open Code engine instance disposed');
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		const client = await ensureClient();
		const models = await fetchOpenCodeModels(client);
		if (models.length === 0) {
			throw new Error('Open Code is not configured. Add a provider in Settings → Engines → Open Code.');
		}
		return models;
	}

	/**
	 * Stream a query through Open Code SDK, yielding EngineOutput (unified types)
	 *
	 * Flow: subscribe to events FIRST, then send prompt asynchronously.
	 * This ensures no events are missed between sending and subscribing.
	 */
	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const {
			projectPath,
			prompt,
			resume,
			providerSlug,
			modelId,
			abortController
		} = options;

		this.activeAbortController = abortController || new AbortController();
		this._isActive = true;
		this.activeProjectPath = projectPath;

		// Active Profile for this stream. Skills go into the prompt and commands
		// into shared dirs; materialize those first, then bind to the per-Profile
		// server that bakes the rest.
		const profileId = options.mcpContext?.profileId;
		await syncSkills('opencode', profileId);
		await syncEngineArtifacts('opencode', profileId);

		// Bind this stream to the pooled server whose baked config matches the
		// Profile: MCP narrowed to the Profile's connectors (drops excluded EXTERNAL
		// servers) plus the Profile's subagents INLINE — Open Code caches its agent
		// registry from a shared dir at boot, so an isolated server is the only way
		// to scope it. The signature keys the pool: identical scoping reuses one
		// server, different Profiles get isolated servers, concurrently.
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		const subagentFilter = artifactFilter(profileId, 'subagent') ?? undefined;
		const inlineAgents = await buildOpenCodeInlineAgents(profileId);
		// Key = filtered MCP set + subagent set + a hash of the agents' CONTENT, so
		// editing a subagent's prompt/model (same set) also spawns a fresh server
		// rather than reusing a stale one. `subagentFilter` is subsumed by the
		// content hash but kept for a readable key.
		const mcpKey = mcpProfileFilter ? [...mcpProfileFilter].sort().join(',') : '*';
		const agentKey = subagentFilter ? [...subagentFilter].sort().join(',') : '*';
		const serverKey = `mcp:${mcpKey}|agents:${agentKey}:${hashConfig(JSON.stringify(inlineAgents))}`;
		const server = await ensureServer(serverKey, { mcpProfileFilter, inlineAgents });
		this.activeServer = server;
		const client = server.client;

		// Resolve the permission policy once per stream; the permission event
		// handler enforces it (OpenCode otherwise auto-approves every tool). Tool
		// identity is matched in the canonical `mapToolName` form so a rule like
		// `mcp__server__tool` works across Claude and OpenCode alike.
		const permissions = resolvePermissionsFromDb('opencode', options.mcpContext?.projectId, profileId);

		debug.log('chat', 'Open Code - Stream Query');
		debug.log('chat', { prompt });

		try {
			const promptParts = this.extractPromptParts(prompt);

			// Prompt-scoped engine: the persistent server reads Skills/Commands/
			// Subagents through shared channels it doesn't reliably re-read per turn,
			// so advertise the profile-scoped set PER-SESSION by prepending it as a
			// leading context part each turn (authoritative for synthetic skills;
			// advisory on top of the native command/agent dirs).
			const artifactsContext = buildArtifactsPromptContext(profileId);
			if (artifactsContext) {
				promptParts.unshift({ type: 'text', text: artifactsContext });
			}

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

			yield convertSystemInitMessage(sessionId, modelId);
			yield convertStreamStart(sessionId);

			// 1. Subscribe to event stream FIRST (before sending prompt)
			const eventResult = await client.event.subscribe({
				query: { directory: projectPath },
				signal: this.activeAbortController.signal
			});

			// 2. Send prompt asynchronously (non-blocking). Disabled tools enforce
			// the deny policy up front (covers read-only + MCP tools that never fire
			// a permission event — see buildOpenCodeToolDisableMap).
			const disabledTools = buildOpenCodeToolDisableMap(permissions);
			// Profile connector scoping (INTERNAL): the shared `clopen-mcp` bridge is
			// all-or-nothing, so disable — for THIS session only (per-prompt `tools`
			// map → concurrency-safe) — the tools of every internal connector the
			// active Profile excludes. External connectors are already absent from
			// this Profile's server (see the pooled server config). No-op when the
			// profile doesn't constrain connectors.
			for (const toolId of getOpenCodeProfileDisabledToolIds(mcpProfileFilter)) {
				disabledTools[toolId] = false;
			}
			client.session.promptAsync({
				path: { id: sessionId },
				body: {
					parts: promptParts as any,
					...(providerSlug && modelId ? { model: { providerID: providerSlug, modelID: modelId } } : {}),
					...(Object.keys(disabledTools).length > 0 ? { tools: disabledTools } : {}),
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
			// callID/partId → raw tool name, so a `permission.asked` event (which
			// carries only a callID) can be resolved to the tool being permitted.
			const callIdToTool = new Map<string, string>();
			const emittedReasoningParts = new Set<string>(); // Reasoning parts already flushed
			let reasoningStreamActive = false; // Whether reasoning is currently streaming
			let reasoningText = ''; // Accumulated reasoning text

			// Child session tracking (for Agent tool sub-messages)
			const childSessionToAgentTool = new Map<string, string>(); // child sessionID → agent tool callID
			const childAssistantMessages = new Map<string, OCMessage>(); // child msgID → message
			const childEmittedToolParts = new Set<string>();
			const childCompletedToolParts = new Set<string>();
			let lastAgentToolCallId: string | null = null;

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
				// Filter out tool parts, subtask parts, and reasoning parts already emitted
				const remainingParts = parts.filter(p => {
					if (p.type === 'tool') return !emittedToolParts.has(p.id);
					if (p.type === 'subtask') return !emittedToolParts.has(p.id);
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

							// Track child session assistant messages (for Agent tool sub-messages)
							if (info.role === 'assistant' && info.sessionID !== sessionId && lastAgentToolCallId) {
								if (!childSessionToAgentTool.has(info.sessionID)) {
									childSessionToAgentTool.set(info.sessionID, lastAgentToolCallId);
									debug.log('engine', `[OC] child session detected: ${info.sessionID} → agent tool ${lastAgentToolCallId}`);
								}
								childAssistantMessages.set(info.id, info);
							}
							break;
						}

						case 'message.part.updated': {
							const props = (event as EventMessagePartUpdated).properties;
							const part = props.part;

							debug.log('engine', `[OC] part.updated: type=${part.type}, partId=${part.id}, msgId=${part.messageID}, session=${part.sessionID === sessionId ? 'match' : 'skip'}`);

							// Handle child session parts (sub-agent tool activities)
							if (part.sessionID !== sessionId) {
								const agentCallId = childSessionToAgentTool.get(part.sessionID);
								if (agentCallId && childAssistantMessages.has(part.messageID)) {
									const childMsg = childAssistantMessages.get(part.messageID)!;

									if (part.type === 'tool') {
										const childToolPart = part as ToolPart;
										if (!childEmittedToolParts.has(part.id)) {
											const resolvedInput = getToolInput(childToolPart);
											const hasInput = Object.keys(resolvedInput).length > 0
												|| childToolPart.state.status !== 'pending';
											if (hasInput) {
												childEmittedToolParts.add(part.id);
												yield convertToolUseOnly(childToolPart, childMsg, sessionId, agentCallId);
												if (childToolPart.state.status === 'completed' || childToolPart.state.status === 'error') {
													childCompletedToolParts.add(part.id);
													yield convertToolResultOnly(childToolPart, sessionId, agentCallId);
												}
											}
										} else if (!childCompletedToolParts.has(part.id)) {
											if (childToolPart.state.status === 'completed' || childToolPart.state.status === 'error') {
												childCompletedToolParts.add(part.id);
												yield convertToolResultOnly(childToolPart, sessionId, agentCallId);
											}
										}
									}
								}
								break;
							}

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

								// Register the tool name against its callID/partId as early as
								// possible (even while pending) so a permission request can be
								// resolved to it before the tool executes.
								if (toolPart.tool) {
									if (toolPart.callID) callIdToTool.set(toolPart.callID, toolPart.tool);
									callIdToTool.set(toolPart.id, toolPart.tool);
								}

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

										// Track agent tool callID for child session linking
										if (toolPart.tool === 'task') {
											lastAgentToolCallId = toolPart.callID || toolPart.id;
										}

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

							// Handle subtask parts — convert to Agent tool_use for progressive rendering
							if (part.type === 'subtask') {
								const subtaskPart = part as any;
								const msg = assistantMessages.get(msgId);
								if (msg && !emittedToolParts.has(part.id)) {
									emittedToolParts.add(part.id);
									// Track for child session linking
									lastAgentToolCallId = part.id;
									if (reasoningStreamActive) {
										yield* flushReasoning(msg);
									}
									yield convertStreamStop(sessionId);
									yield convertSubtaskToolUseOnly(subtaskPart, msg, sessionId);
									yield convertStreamStart(sessionId);
									streamingText = '';
								}
								break;
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
							// Only handle idle for our session (sub-agent sessions have different IDs)
							const idleProps = (event as EventSessionIdle).properties;
							if (idleProps.sessionID !== sessionId) {
								debug.log('engine', `[OC] session.idle: ignored (session=${idleProps.sessionID}, ours=${sessionId})`);
								break;
							}
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
										if (p.type === 'subtask') return !emittedToolParts.has(p.id);
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
							const statusProps = (event as EventSessionStatus).properties;
							// Only handle status for our session (sub-agent sessions have different IDs)
							if (statusProps.sessionID !== sessionId) break;
							const { status } = statusProps;
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
											if (p.type === 'subtask') return !emittedToolParts.has(p.id);
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

						// v2 question event — emitted when the question tool needs user input
						case 'question.asked': {
							const props = evt.properties as {
								id: string;
								sessionID: string;
								questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }> }>;
								tool?: { messageID: string; callID: string };
							};
							if (props.sessionID !== sessionId) break;
							if (props.tool?.callID) {
								this.pendingQuestions.set(props.tool.callID, {
									requestId: props.id,
									questions: props.questions,
								});
								debug.log('engine', `[OC] question.asked: stored question ${props.id} for callID ${props.tool.callID}`);
							}
							break;
						}

						// v2 permission event — consult the permission policy, then
						// approve (default) or reject the tool. OpenCode otherwise
						// bypasses every tool permission.
						case 'permission.asked':
						case 'permission.updated': {
							const props = evt.properties as {
								id: string;
								sessionID: string;
								callID?: string;
								type?: string;
							};
							if (props.sessionID !== sessionId) break;
							// Resolve the tool being permitted (callID → tool name captured
							// from the tool-part stream; fall back to the event `type`).
							const rawTool = (props.callID && callIdToTool.get(props.callID)) || props.type;
							const blocked = rawTool ? isOpenCodeToolBlocked(permissions, rawTool) : false;
							if (blocked) {
								debug.log('permissions', `⛔ Blocked tool "${rawTool}" (Clopen permission policy)`);
							}
							this.replyPermission(props.id, props.sessionID, blocked ? 'reject' : 'once');
							break;
						}

						case 'session.error': {
							const errorProps = (event as EventSessionError).properties;
							// Only handle errors for our session (sessionID is optional on errors)
							if (errorProps.sessionID && errorProps.sessionID !== sessionId) break;
							const errorMsg = formatSessionError(errorProps);
							debug.error('engine', '[OC] session.error:', errorMsg);
							throw new Error(errorMsg);
						}
					}
				}
			}

		} catch (error) {
			handleStreamError(error);
		} finally {
			this._isActive = false;
			this.activeAbortController = null;
			this.activeSessionId = null;
			this.activeProjectPath = null;
			this.pendingQuestions.clear();
		}
	}

	async cancel(): Promise<void> {
		// Capture refs before clearing — needed for server-side abort below
		const sessionId = this.activeSessionId;
		const projectPath = this.activeProjectPath;

		// 1. FIRST: Abort local stream processing immediately.
		//    This breaks the SSE event stream and causes the for-await loop
		//    in processStream() to throw AbortError, stopping all local processing.
		//    Must happen BEFORE the HTTP call because client.session.abort() can
		//    hang indefinitely if the OpenCode server is busy/unresponsive.
		if (this.activeAbortController) {
			this.activeAbortController.abort();
			this.activeAbortController = null;
		}
		this._isActive = false;
		this.activeSessionId = null;
		this.activeProjectPath = null;
		this.pendingQuestions.clear();

		// 2. THEN: Tell the OpenCode server to stop processing (with timeout).
		//    This is a courtesy cleanup — local processing is already stopped.
		//    The server-side session would otherwise keep running (consuming
		//    LLM API calls and compute resources) until it naturally completes.
		const client = this.activeServer?.client ?? getClient();
		if (client && sessionId) {
			try {
				await Promise.race([
					client.session.abort({
						path: { id: sessionId },
						...(projectPath && { query: { directory: projectPath } }),
					}),
					new Promise<void>(resolve => setTimeout(resolve, 5000))
				]);
				debug.log('engine', 'Open Code session aborted:', sessionId);
			} catch (error) {
				debug.warn('engine', 'Failed to abort Open Code session (non-fatal):', error);
			}
		}
	}

	/**
	 * Cancel a specific session on the OpenCode server.
	 * Used by stream-manager for per-project isolation (instead of global cancel).
	 */
	async cancelSession(sessionId: string, projectPath?: string): Promise<void> {
		const client = this.activeServer?.client ?? getClient();
		if (!client || !sessionId) return;
		try {
			await Promise.race([
				client.session.abort({
					path: { id: sessionId },
					...(projectPath && { query: { directory: projectPath } }),
				}),
				new Promise<void>(resolve => setTimeout(resolve, 5000))
			]);
			debug.log('engine', 'Open Code session aborted (per-stream):', sessionId);
		} catch (error) {
			debug.warn('engine', 'Failed to abort Open Code session (non-fatal):', error);
		}
	}

	async interrupt(): Promise<void> {
		// Open Code SDK doesn't have a separate interrupt — use cancel
		await this.cancel();
	}

	/**
	 * Resolve a pending AskUserQuestion by replying via the OpenCode question API.
	 *
	 * Flow:
	 * 1. If a `question.asked` event was received → use stored requestId to reply
	 * 2. Fallback → fetch pending questions from GET /question and match by callID
	 *
	 * The reply is sent to POST /question/{requestID}/reply with answers
	 * ordered by the original questions array.
	 */
	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		const pending = this.pendingQuestions.get(toolUseId);

		if (pending) {
			// Convert Record<questionText, answerLabel> → Array<Array<string>> ordered by questions
			const orderedAnswers = pending.questions.map(q => {
				const answer = answers[q.question];
				return answer ? [answer] : [];
			});
			this.replyToQuestion(pending.requestId, orderedAnswers);
			this.pendingQuestions.delete(toolUseId);
			return true;
		}

		// Fallback: fetch pending questions from the API and find matching one
		debug.log('engine', `resolveUserAnswer: No stored question for toolUseId ${toolUseId}, fetching from API...`);
		this.fetchAndReplyToQuestion(toolUseId, answers);
		return true;
	}

	/**
	 * POST /question/{requestID}/reply to send user answers back to the OpenCode server.
	 */
	private replyToQuestion(requestId: string, orderedAnswers: string[][]): void {
		const serverUrl = this.activeServer?.url ?? getServerUrl();
		if (!serverUrl) {
			debug.warn('engine', 'replyToQuestion: Server URL not available');
			return;
		}

		const dirParam = this.activeProjectPath ? `?directory=${encodeURIComponent(this.activeProjectPath)}` : '';
		const url = `${serverUrl}/question/${requestId}/reply${dirParam}`;
		debug.log('engine', `Replying to question ${requestId}:`, orderedAnswers);

		fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ answers: orderedAnswers }),
		}).then(async res => {
			if (res.ok) {
				debug.log('engine', `Question reply accepted: ${requestId} (${res.status})`);
			} else {
				const body = await res.text().catch(() => '');
				debug.error('engine', `Question reply failed: ${res.status} ${res.statusText}`, body);
			}
		}).catch(error => {
			debug.error('engine', 'Failed to reply to question:', error);
		});
	}

	/**
	 * Fallback: GET /question to list pending questions, find the matching one, and reply.
	 */
	private async fetchAndReplyToQuestion(toolUseId: string, answers: Record<string, string>): Promise<void> {
		const serverUrl = this.activeServer?.url ?? getServerUrl();
		if (!serverUrl) {
			debug.warn('engine', 'fetchAndReplyToQuestion: Server URL not available');
			return;
		}

		try {
			const dirParam = this.activeProjectPath ? `?directory=${encodeURIComponent(this.activeProjectPath)}` : '';
			const res = await fetch(`${serverUrl}/question${dirParam}`);
			if (!res.ok) {
				debug.error('engine', `Failed to list pending questions: ${res.status}`);
				return;
			}

			const questions = await res.json() as Array<{
				id: string;
				questions: Array<{ question: string }>;
				tool?: { callID: string };
			}>;

			const matching = questions.find(q => q.tool?.callID === toolUseId);
			if (!matching) {
				debug.warn('engine', 'fetchAndReplyToQuestion: No matching question for toolUseId:', toolUseId);
				return;
			}

			const orderedAnswers = matching.questions.map(q => {
				const answer = answers[q.question];
				return answer ? [answer] : [];
			});
			this.replyToQuestion(matching.id, orderedAnswers);
		} catch (error) {
			debug.error('engine', 'Failed to fetch and reply to question:', error);
		}
	}

	/**
	 * Reply to a permission request. `response` is `'once'` to approve (the
	 * default, keeping the session unblocked) or `'reject'` to deny a tool blocked
	 * by the permission policy. Uses direct HTTP since the v1 client may not have
	 * the v2 permission.reply method.
	 */
	private replyPermission(permissionId: string, sessionId: string, response: 'once' | 'reject'): void {
		const serverUrl = this.activeServer?.url ?? getServerUrl();
		if (!serverUrl) return;
		const verb = response === 'reject' ? 'rejected' : 'approved';

		// Try v2 endpoint first (/permission/{requestID}/reply), fall back to v1
		fetch(`${serverUrl}/permission/${permissionId}/reply`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reply: response }),
		}).then(res => {
			if (res.ok) {
				debug.log('engine', `[OC] ${verb} permission ${permissionId} (v2)`);
				return;
			}
			// v2 endpoint not available — try v1
			const client = this.activeServer?.client ?? getClient();
			if (client) {
				client.postSessionIdPermissionsPermissionId({
					path: { id: sessionId, permissionID: permissionId },
					body: { response },
					...(this.activeProjectPath && { query: { directory: this.activeProjectPath } }),
				}).then(() => {
					debug.log('engine', `[OC] ${verb} permission ${permissionId} (v1)`);
				}).catch(err => {
					debug.error('engine', 'Failed to reply to permission (v1):', err);
				});
			}
		}).catch(error => {
			debug.error('engine', 'Failed to reply to permission:', error);
		});
	}

	/**
	 * Extract prompt parts (text + file attachments) from UserMessage.
	 * Converts unified content blocks to OpenCode FilePartInput format.
	 */
	private extractPromptParts(prompt: UserMessage): Array<
		| { type: 'text'; text: string }
		| { type: 'file'; mime: string; filename?: string; url: string }
	> {
		const parts: Array<
			| { type: 'text'; text: string }
			| { type: 'file'; mime: string; filename?: string; url: string }
		> = [];

		for (const block of prompt.content) {
			if (block.type === 'text') {
				parts.push({ type: 'text', text: block.text });
			} else if (block.type === 'image') {
				parts.push({
					type: 'file',
					mime: block.mediaType,
					url: `data:${block.mediaType};base64,${block.data}`,
				});
			} else if (block.type === 'document') {
				parts.push({
					type: 'file',
					mime: block.mediaType,
					filename: block.title || undefined,
					url: `data:${block.mediaType};base64,${block.data}`,
				});
			}
		}

		if (parts.length === 0) {
			parts.push({ type: 'text', text: '' });
		}
		return parts;
	}

	/**
	 * One-shot structured JSON generation.
	 * Uses the v1 SDK client.session.prompt() (synchronous) with prompt
	 * engineering for JSON output since v1 doesn't support format option.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const {
			prompt,
			providerSlug,
			modelId,
			schema,
			projectPath,
			abortController
		} = options;

		if (!this._isInitialized) {
			await this.initialize();
		}

		const client = await ensureClient();

		// Create a temporary session for this one-shot request
		const sessionResult = await client.session.create({
			query: { directory: projectPath }
		});
		const sessionId = sessionResult.data?.id;
		if (!sessionId) {
			throw new Error('Failed to create OpenCode session');
		}

		const jsonPrompt = buildJsonPrompt(prompt, schema);

		debug.log('engine', `[OC structured] Sending prompt to session ${sessionId}, provider=${providerSlug}, modelId=${modelId}`);

		// Use v1 SDK synchronous prompt method — waits for completion
		const response = await client.session.prompt({
			path: { id: sessionId },
			body: {
				parts: [{ type: 'text', text: jsonPrompt }],
				...(providerSlug && modelId ? { model: { providerID: providerSlug, modelID: modelId } } : {}),
				tools: {}
			},
			query: { directory: projectPath },
			...(abortController?.signal && { signal: abortController.signal })
		});

		const data = response.data;
		if (!data) {
			throw new Error('OpenCode returned empty response');
		}

		const parts = data.parts || [];
		debug.log('engine', `[OC structured] Got response with ${parts.length} parts (${parts.map((p: any) => p.type).join(', ')})`);

		// Prefer `text` parts but fall back to `reasoning` parts: some models
		// (notably thinking-heavy ones) emit JSON inside reasoning when tools
		// are disabled and the prompt is short. Both carry a `.text` field.
		const collectText = (type: 'text' | 'reasoning') =>
			parts
				.filter((p: any) => p.type === type && !p.ignored)
				.map((p: any) => p.text || '')
				.join('');

		const textContent = collectText('text');
		const source = textContent || collectText('reasoning');

		if (!source) {
			throw new Error(
				`OpenCode returned no parseable content (received parts: ${parts.map((p: any) => p.type).join(', ') || 'none'})`
			);
		}

		debug.log('engine', `[OC structured] Raw text: ${source.slice(0, 200)}`);

		return extractJson<T>(source);
	}
}
