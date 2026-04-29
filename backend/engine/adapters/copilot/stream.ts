/**
 * Copilot Engine Adapter
 *
 * Wraps the @github/copilot-sdk into the AIEngine interface.
 * One CopilotClient per project — abort controllers and active sessions are
 * isolated by the per-project engine registry in backend/engine/index.ts.
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type {
	CopilotSession,
	SessionConfig,
	ResumeSessionConfig,
	SessionEvent,
	ModelInfo,
} from '@github/copilot-sdk';
import type { EngineOutput, EngineModel } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions } from '../../types';
import { engineQueries } from '$backend/database/queries/engine-queries';
import { resolveOsPath } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import { getCopilotMcpConfig } from '../../../mcp/config';
import { handleStreamError, buildSessionError } from './error-handler';

// `UserInputResponse` isn't part of the SDK's public type exports
// (see `node_modules/@github/copilot-sdk/dist/index.d.ts`), but
// `onUserInputRequest`'s return type is exactly that shape — derive
// it from the SessionConfig field so we don't drift from the SDK.
type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>>;
import {
	createStreamConverterState,
	convertSessionStart,
	convertTurnStart,
	convertTurnEnd,
	convertReasoning,
	convertReasoningDelta,
	convertMessageDelta,
	convertAssistantMessage,
	convertToolStart,
	convertToolComplete,
	captureUsage,
	buildResultEvent,
	flushPending,
	resolveParentToolUseId,
	convertSubagentStarted,
	convertSubagentEnded,
} from './message-converter';
import { forkCopilotSessionState, sessionStateExists } from './session-fork';

const ABORT_TIMEOUT_MS = 5000;

/**
 * Pending AskUserQuestion entry — the Copilot SDK's `onUserInputRequest`
 * callback is parked on a Promise stored here, keyed by the `toolCallId`
 * of the originating `ask_user` tool block. `resolveUserAnswer` looks it
 * up and resolves the Promise, unblocking the SDK so the agent's turn
 * can continue.
 *
 * `choices` is captured so we can decide `wasFreeform` (Copilot's SDK
 * field) by checking whether the user's answer is one of the predefined
 * choices — a freeform answer would mean the user typed something not
 * in the choices array.
 */
interface PendingCopilotUserAnswer {
	resolve: (response: UserInputResponse) => void;
	choices?: string[];
}

export class CopilotEngine implements AIEngine {
	readonly name = 'copilot' as const;

	private _isInitialized = false;
	private client: CopilotClient | null = null;
	private activeSession: CopilotSession | null = null;
	private activeController: AbortController | null = null;
	private modelsCache: ModelInfo[] | null = null;
	/**
	 * Account ID currently baked into `this.client`. The Copilot SDK takes the
	 * GitHub token as a constructor argument, so per-stream account overrides
	 * require disposing and re-creating the client (see streamQuery below).
	 */
	private currentAccountId: number | null = null;

	/**
	 * AskUserQuestion bookkeeping. The Copilot SDK splits the `ask_user`
	 * flow across two channels:
	 *   - the `assistant.message` / `tool.execution_start` /
	 *     `user_input.requested` events all carry the `toolCallId` of the
	 *     `ask_user` invocation (matching the tool_use block in the UI)
	 *   - `onUserInputRequest` callback carries the question/choices but
	 *     NOT the toolCallId (see `node_modules/@github/copilot-sdk/dist/client.js::handleUserInputRequest`)
	 *
	 * To correlate the two we capture the most recent `toolCallId` from
	 * those events into `pendingAskUserToolCallId`, then read it inside
	 * the callback. Only one `ask_user` can be outstanding per session at
	 * a time (the SDK blocks the agent's turn until the callback returns),
	 * so a single-slot variable is sufficient.
	 */
	private pendingUserAnswers = new Map<string, PendingCopilotUserAnswer>();
	private pendingAskUserToolCallId: string | null = null;

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	get isActive(): boolean {
		return this.activeController !== null;
	}

	async initialize(accountId?: number): Promise<void> {
		if (this._isInitialized && (accountId == null || accountId === this.currentAccountId)) {
			return;
		}

		const account = accountId != null
			? engineQueries.getAccount(accountId)
			: engineQueries.getActiveAccountForEngine('copilot');
		if (!account) {
			throw new Error('No active GitHub Copilot account. Add a Personal Access Token in Settings → Engines.');
		}

		this.client = new CopilotClient({
			gitHubToken: account.credential,
			useLoggedInUser: false,
			autoStart: true,
		});

		await this.client.start();
		this.currentAccountId = account.id;
		this._isInitialized = true;
		debug.log('engine', `Copilot engine initialized (account ${account.id})`);
	}

	async dispose(): Promise<void> {
		await this.cancel();

		if (this.client) {
			try {
				const errors = await this.client.stop();
				if (errors.length > 0) {
					debug.warn('engine', 'Copilot client.stop() reported errors:', errors);
				}
			} catch (error) {
				debug.warn('engine', 'Copilot client.stop() failed (non-fatal):', error);
				try {
					await this.client.forceStop();
				} catch (forceErr) {
					debug.warn('engine', 'Copilot client.forceStop() failed:', forceErr);
				}
			}
		}

		this.client = null;
		this.modelsCache = null;
		this.currentAccountId = null;
		this._isInitialized = false;
		debug.log('engine', 'Copilot engine disposed');
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		if (!this.client) {
			try {
				await this.initialize();
			} catch (error) {
				debug.warn('engine', 'Copilot getAvailableModels: initialize failed:', error);
				return [];
			}
		}
		if (!this.client) return [];

		try {
			const infos = this.modelsCache ?? await this.client.listModels();
			this.modelsCache = infos;
			return infos.map(info => mapModelInfoToEngineModel(info));
		} catch (error) {
			debug.warn('engine', `Copilot models unavailable: ${summariseModelsError(error)}`);
			return [];
		}
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const { projectPath, prompt, resume, modelId, abortController, accountId } = options;

		// Per-stream account override: the Copilot SDK takes the GitHub token at
		// construction time, so an account switch requires recreating the client.
		if (this._isInitialized && accountId != null && accountId !== this.currentAccountId) {
			debug.log('engine', `Copilot account switch ${this.currentAccountId} → ${accountId}; re-initializing client`);
			await this.dispose();
		}

		if (!this._isInitialized || !this.client) {
			await this.initialize(accountId);
		}
		if (!this.client) {
			throw new Error('Copilot client unavailable.');
		}

		this.activeController = abortController || new AbortController();

		const resolvedProjectPath = resolveOsPath(projectPath);
		const state = createStreamConverterState('', modelId);

		// Buffered queue between async event handler and the for-await consumer.
		const queue: SessionEvent[] = [];
		let waiter: ((value: SessionEvent | null) => void) | null = null;
		let finished = false;

		const pushEvent = (event: SessionEvent | null) => {
			if (waiter) {
				const w = waiter;
				waiter = null;
				w(event);
			} else if (event) {
				queue.push(event);
			}
		};

		const handler = (event: SessionEvent) => {
			// The Copilot SDK does NOT pass `toolCallId` to the
			// `onUserInputRequest` callback, so we have to capture it from
			// the surrounding event stream and read it inside the callback.
			//
			// Capture order matters — `assistant.message` is dispatched
			// FIRST (when the model decides to call `ask_user`), then
			// `tool.execution_start`, then the RPC that triggers our
			// callback. `user_input.requested` is ephemeral and not
			// guaranteed to be observed before the callback fires (in
			// practice it can race or be dropped), so we cannot depend on
			// it alone — that was the bug behind the empty-answer
			// auto-resolve.
			if (event.type === 'assistant.message' && event.data.toolRequests) {
				for (const req of event.data.toolRequests) {
					if (req.name === 'ask_user') {
						this.pendingAskUserToolCallId = req.toolCallId;
					}
				}
			} else if (event.type === 'tool.execution_start' && event.data.toolName === 'ask_user') {
				this.pendingAskUserToolCallId = event.data.toolCallId;
			} else if (event.type === 'user_input.requested' && event.data.toolCallId) {
				this.pendingAskUserToolCallId = event.data.toolCallId;
			}
			pushEvent(event);
		};

		const onAbort = () => {
			finished = true;
			pushEvent(null);
		};
		this.activeController.signal.addEventListener('abort', onAbort, { once: true });

		try {
			const mcpConfig = getCopilotMcpConfig();

			const baseConfig: ResumeSessionConfig = {
				onPermissionRequest: approveAll,
				// Enables the agent's `ask_user` tool. Without this callback the
				// SDK reports `requestUserInput: false` to the server and the
				// tool is not exposed to the model, so the AskUserQuestion
				// converter at message-converter.ts::normalizeAskUserQuestionInput
				// never fires. Mirrors the in-process callback pattern documented
				// in README.md §6.4 (Claude's `canUseTool`).
				onUserInputRequest: async (request) => {
					// Match Claude's `canUseTool` and OpenCode's `question.asked`
					// patterns: park the callback on a Promise and only resolve
					// it when the user submits an answer via the chat UI (routed
					// through `resolveUserAnswer` below). Returning early would
					// inject a fake answer into the model's context.
					//
					// `pendingAskUserToolCallId` was captured from the preceding
					// `assistant.message` / `tool.execution_start` event (see
					// handler above). If for any reason it's missing, fall back
					// to a synthetic id so `cancel()` can still release the
					// Promise — but log loudly because the chat UI's answer
					// submission won't reach this entry.
					const captured = this.pendingAskUserToolCallId;
					this.pendingAskUserToolCallId = null;
					const toolCallId = captured ?? `copilot-ask-user-${crypto.randomUUID()}`;

					if (captured) {
						debug.log('engine', `Copilot ask_user: parking on resolveUserAnswer (toolCallId: ${toolCallId})`);
					} else {
						debug.warn('engine', `Copilot ask_user: no toolCallId captured from event stream — parked on synthetic id ${toolCallId} (UI answer will not unblock; only cancel() will)`);
					}

					return await new Promise<UserInputResponse>((resolve) => {
						this.pendingUserAnswers.set(toolCallId, {
							resolve,
							choices: request.choices,
						});
					});
				},
				model: modelId,
				workingDirectory: resolvedProjectPath,
				onEvent: handler,
				// Emit assistant.message_delta / assistant.reasoning_delta events
				// so the chat UI can render text token-by-token.
				streaming: true,
				// Sub-agent (`task`) activity is rendered nested inside the parent
				// Agent tool block (see frontend/utils/chat/tool-handler.ts), not as
				// live deltas in the main stream. Suppressing sub-agent streaming
				// keeps reasoning/text from sub-agents from leaking into the main
				// turn; the final non-streaming `assistant.message`,
				// `assistant.reasoning`, and `tool.execution_*` events still arrive
				// and are routed via parent.toolUseId.
				includeSubAgentStreamingEvents: false,
				// Custom MCP tools served from Clopen's in-process remote MCP HTTP
				// endpoint (`/mcp`). Same `clopen-mcp` namespace and URL Open Code
				// and Codex consume — see backend/engine/README.md §9.12.
				...(Object.keys(mcpConfig).length > 0 && { mcpServers: mcpConfig }),
			};

			let session: CopilotSession;
			if (resume) {
				// Fork-by-copy on EVERY resume — same semantics as Claude
				// (`forkSession: true`) and OpenCode (`client.session.fork()`):
				// each turn must produce a brand-new session id so the original
				// branch's history is never mutated and the multi-branch
				// checkpoint tree stays consistent. Without this, every turn
				// reuses the same Copilot session id and downstream
				// checkpoint/branch logic loses the ability to replay an
				// earlier point as an independent sibling.
				//
				// Falls through to a plain resume only when the source state
				// can't be found on disk (best-effort recovery).
				//
				// TODO: replace this fork-by-copy block with a native SDK API
				// once @github/copilot-sdk adds `forkSession` (issues
				// github/copilot-cli#1313, #1697, #2058). The migration is the
				// same one-liner Claude and OpenCode already use.
				let resumeId = resume;
				if (sessionStateExists(resume)) {
					const forkId = crypto.randomUUID();
					if (forkCopilotSessionState(resume, forkId)) {
						resumeId = forkId;
					}
				}

				try {
					session = await this.client.resumeSession(resumeId, baseConfig);
					debug.log('engine', `Copilot resumed session: ${resumeId}${resumeId === resume ? '' : ` (forked from ${resume})`}`);
				} catch (error) {
					debug.warn('engine', `Failed to resume Copilot session ${resumeId}, creating fresh:`, error);
					session = await this.client.createSession({ ...baseConfig } as SessionConfig);
				}
			} else {
				session = await this.client.createSession({ ...baseConfig } as SessionConfig);
			}

			this.activeSession = session;
			state.sessionId = session.sessionId;

			// Send the prompt — fire-and-forget; events arrive via the queue.
			const sendPromise = session.send({ prompt: extractPromptText(prompt) }).catch(error => {
				debug.error('engine', 'Copilot session.send error:', error);
				pushEvent({
					type: 'session.error',
					id: crypto.randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					data: {
						errorType: 'query',
						message: error instanceof Error ? error.message : String(error),
					},
				} as SessionEvent);
			});

			// Drain the event queue.
			while (!finished) {
				if (this.activeController.signal.aborted) break;

				const event: SessionEvent | null = queue.length > 0
					? queue.shift()!
					: await new Promise<SessionEvent | null>(resolve => {
						waiter = resolve;
					});

				if (!event || this.activeController.signal.aborted) break;

				// Resolve the parent Agent (`task`) tool call id for events
				// originating inside a sub-agent. Null for the root agent and
				// session-level events. Stamped on persisted messages so the
				// frontend grouper nests sub-agent activity under the parent
				// Agent tool — same shape Claude/OpenCode produce.
				const parentToolUseId = resolveParentToolUseId(event, state);

				switch (event.type) {
					case 'session.start':
						yield convertSessionStart(event.data, state.modelId);
						break;

					case 'assistant.turn_start':
						// Sub-agent turn lifecycle is internal to the Agent tool block —
						// don't toggle the main chat's stream lifecycle for it.
						if (parentToolUseId) break;
						yield convertTurnStart(state);
						break;

					case 'assistant.reasoning_delta':
						if (parentToolUseId) break;
						yield* convertReasoningDelta(event.data, state);
						break;

					case 'assistant.reasoning':
						yield* convertReasoning(event.data, state, parentToolUseId);
						break;

					case 'assistant.message_delta':
						if (parentToolUseId) break;
						yield* convertMessageDelta(event.data, state);
						break;

					case 'assistant.message':
						// May yield previously-buffered messages; the new message
						// is buffered until assistant.usage attaches token counts.
						yield* convertAssistantMessage(event.data, state, parentToolUseId);
						break;

					case 'tool.execution_start':
						// Normally we DON'T flush pending assistant messages
						// here — the SDK typically emits `assistant.usage`
						// AFTER `assistant.message` but BEFORE this event, and
						// we want to preserve that usage attachment by leaving
						// messages buffered. Tool start has no user-visible
						// output so deferring is usually safe.
						//
						// EXCEPTION: `ask_user` parks the SDK on the
						// `onUserInputRequest` callback (see baseConfig above),
						// so no further events arrive until the user responds.
						// If we don't flush here, the assistant.message holding
						// the `ask_user` tool_use block stays buffered forever
						// and the AskUserQuestion bubble never reaches the UI
						// — leaving the user with no way to answer.
						if (event.data.toolName === 'ask_user') {
							yield* flushPending(state);
						}
						yield* convertToolStart(event.data, state);
						break;

					case 'tool.execution_complete':
						yield* flushPending(state);
						yield* convertToolComplete(event.data, state, parentToolUseId);
						break;

					case 'assistant.usage':
						// Sub-agent usage belongs to its own LLM call, not the main
						// turn — skip so we don't attach it to a parent message.
						if (parentToolUseId) break;
						// Attaches usage to the last pending message and flushes.
						yield* captureUsage(event.data, state);
						break;

					case 'assistant.turn_end':
						if (parentToolUseId) break;
						for (const ev of convertTurnEnd(event.data, state)) {
							yield ev;
						}
						break;

					case 'subagent.started':
						yield* convertSubagentStarted(event, state);
						break;

					case 'subagent.completed':
					case 'subagent.failed':
						yield* convertSubagentEnded(event, state);
						break;

					case 'abort':
						finished = true;
						break;

					case 'session.error':
						throw buildSessionError(event.data);

					case 'session.idle':
						yield* flushPending(state);
						yield buildResultEvent(state, !!event.data?.aborted);
						finished = true;
						break;
				}
			}

			await sendPromise;
		} catch (error) {
			handleStreamError(error);
		} finally {
			this.activeController.signal.removeEventListener('abort', onAbort);

			if (this.activeSession) {
				try {
					await this.activeSession.disconnect();
				} catch (error) {
					debug.warn('engine', 'Copilot session.disconnect failed (non-fatal):', error);
				}
			}
			this.activeSession = null;
			this.activeController = null;
		}
	}

	async cancel(): Promise<void> {
		// 1. Release any parked `onUserInputRequest` callbacks with an empty
		// answer so the SDK isn't left blocked on a Promise that will never
		// resolve. Empty `answer` + `wasFreeform: false` is the SDK-safe way
		// to unblock without injecting fake user input.
		for (const [, pending] of this.pendingUserAnswers) {
			pending.resolve({ answer: '', wasFreeform: false });
		}
		this.pendingUserAnswers.clear();
		this.pendingAskUserToolCallId = null;

		// 2. Abort the local stream first so the loop exits even if RPC hangs.
		const session = this.activeSession;
		if (this.activeController && !this.activeController.signal.aborted) {
			this.activeController.abort();
		}
		this.activeController = null;

		// 3. Tell the Copilot server to stop processing (with timeout).
		if (session) {
			try {
				await Promise.race([
					session.abort(),
					new Promise<void>(resolve => setTimeout(resolve, ABORT_TIMEOUT_MS)),
				]);
				debug.log('engine', 'Copilot session aborted:', session.sessionId);
			} catch (error) {
				debug.warn('engine', 'Copilot session.abort failed (non-fatal):', error);
			}
		}
	}

	async interrupt(): Promise<void> {
		await this.cancel();
	}

	/**
	 * Resolve a pending Copilot AskUserQuestion. Routed here from
	 * `backend/chat/stream-manager.ts::resolveUserAnswer` when the user
	 * submits an answer via the `chat:ask-user-answer` WS event.
	 *
	 * The unified UI passes `answers` keyed by question text. Copilot's
	 * `ask_user` only ever has a single question per call, so we take the
	 * first value and feed it to the SDK as `{ answer, wasFreeform }`.
	 * `wasFreeform` is derived by checking whether the answer matches one
	 * of the predefined `choices` captured when the callback was parked.
	 */
	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		const pending = this.pendingUserAnswers.get(toolUseId);
		if (!pending) {
			debug.warn('engine', 'Copilot resolveUserAnswer: no pending question for toolUseId:', toolUseId);
			return false;
		}

		const answer = Object.values(answers)[0] ?? '';
		const wasFreeform = pending.choices ? !pending.choices.includes(answer) : true;

		debug.log('engine', `Copilot resolveUserAnswer (toolUseId: ${toolUseId}, wasFreeform: ${wasFreeform})`);
		pending.resolve({ answer, wasFreeform });
		this.pendingUserAnswers.delete(toolUseId);
		return true;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a one-line, human-readable summary of a models.list failure for the
 * server log. Strips the JSON-RPC stack frame noise and maps known GitHub
 * Copilot 4xx responses to actionable hints.
 */
function summariseModelsError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const firstLine = raw.split('\n')[0]?.trim() || raw;

	if (raw.includes('Personal Access Tokens are not supported')) {
		return 'the models.list endpoint does not accept fine-grained PATs (chat will still work if the PAT has Copilot Requests).';
	}
	if (raw.includes('Copilot Requests')) {
		return 'PAT is missing the "Copilot Requests" permission.';
	}
	if (raw.includes('401') || raw.toLowerCase().includes('unauthorized')) {
		return 'unauthorized — check that the GitHub PAT is valid and has Copilot access.';
	}
	return firstLine;
}

function extractPromptText(prompt: EngineQueryOptions['prompt']): string {
	const parts: string[] = [];
	for (const block of prompt.content) {
		if (block.type === 'text') {
			parts.push(block.text);
		}
	}
	return parts.join('\n').trim();
}

function mapModelInfoToEngineModel(info: ModelInfo): EngineModel {
	const limits = info.capabilities?.limits;
	const supports = info.capabilities?.supports;
	return {
		engine: {
			type: 'copilot',
			provider: 'github',
			model: { id: info.id, name: info.name },
			account: { id: 0, name: '' },
		},
		limit: {
			input: limits?.max_context_window_tokens ?? 0,
			output: 0,
		},
		modalities: {
			input: {
				text: true,
				image: !!supports?.vision,
				audio: false,
				video: false,
				pdf: false,
			},
			output: {
				text: true,
				image: false,
				audio: false,
				video: false,
				pdf: false,
			},
		},
		capabilities: {
			reasoning: !!supports?.reasoningEffort,
			tools: true,
			structuredOutput: false,
		},
		cost: {
			input: info.billing?.multiplier ?? 0,
			output: 0,
		},
	};
}
