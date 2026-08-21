/**
 * Qwen Code Engine Adapter
 *
 * Wraps `@qwen-code/sdk` into the AIEngine interface. The SDK manages a
 * `qwen` subprocess per `query()` call (CLI is bundled with the SDK from
 * v0.1.1+). We own the `Query` lifecycle, an `AbortController` and the
 * `pendingAskUserQuestion` slot of the blocking AskUserQuestion flow — all of
 * it per RUN, since one instance serves every chat session of a project and
 * several of them can be streaming at the same time.
 *
 * Auth: paste-token only. `engine_accounts.credential` stores the
 * OpenAI-compatible API key; the active account is read on every stream
 * (env-var SDK pattern, no client construction state — no Restart-Server
 * UX needed).
 *
 * MCP: reuses the existing remote MCP HTTP server at `/mcp` via
 * `getQwenMcpConfig()`. Tool handlers run in-process in the Clopen backend
 * (README §10.12).
 *
 * AskUserQuestion: Qwen's `canUseTool` callback signature does NOT include
 * the tool_use_id (see `node_modules/@qwen-code/sdk/dist/index.d.ts:406-409`),
 * so we cannot key pending answers by id at the moment the SDK invokes the
 * callback. The SDK serialises AskUserQuestion — only one can be pending at
 * a time — so we keep a single slot and recover the real tool_use_id from
 * the converter (which sees the `assistant` message that carries the block
 * id) and stamp it onto the slot. `resolveUserAnswer(toolUseId, …)` then
 * accepts answers either matching that recorded id or for the slot when no
 * id has been recorded yet (race on which lands first).
 */

import type {
	Query,
	QueryOptions,
	SDKMessage,
	SDKUserMessage,
	PermissionResult,
	ToolInput,
} from '@qwen-code/sdk';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import type { EngineOutput, EngineModel } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import { buildJsonPrompt, extractJson } from '../../structured-helpers';
import { resolveOsPath } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import { getEngineEnv } from './environment';
import { handleStreamError } from './error-handler';
import { createSdkMessageConverter, toSdkUserMessage, type SdkMessageConverter } from './message-converter';
import { fetchQwenModels } from './models';
import { getQwenMcpConfig } from '../../../mcp';
import { EngineRuns } from '../run-registry';
import { artifactFilter } from '$backend/profiles';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts } from '$backend/engine/artifact-sync';
import { resolvePermissionsFromDb, isToolAllowed, excludedBuiltinTools } from '$backend/permissions';
import { forkQwenSessionState, sessionStateExists } from './session-fork';

interface PendingAskUserQuestion {
	resolve: (result: PermissionResult) => void;
	removeAbortListener: () => void;
	input: ToolInput;
	/**
	 * The tool_use_id the frontend will send back when answering, learned
	 * from the converter when it sees the `ask_user_question` tool_use block.
	 * Null until the assistant message arrives (canUseTool can fire either
	 * before or after that on the wire).
	 */
	toolUseId: string | null;
}

/**
 * One stream in flight on this instance. All of it used to be instance fields,
 * which only held the most recently started stream — so a second chat in the
 * same project silently took over the first one's query, converter and parked
 * question, and cancelling either one tore down the wrong stream.
 */
interface QwenRun {
	/** Identity of the run — the controller the caller passed to streamQuery. */
	controller: AbortController;
	query: Query | null;
	/**
	 * Live converter for this run — used by `resolveUserAnswer` to push the
	 * user's answers into the converter state so the eventual AUQ tool_result
	 * can be rewritten with the actual answers (the Qwen SDK's `canUseTool` →
	 * AUQ tool execution path drops `answers` on the floor; see the comment
	 * block at the top of `message-converter.ts` and the analysis in
	 * `qwen/stream.ts::canUseTool` for AskUserQuestion).
	 */
	converter: SdkMessageConverter | null;
	pendingAskUserQuestion: PendingAskUserQuestion | null;
}

export class QwenEngine implements AIEngine {
	readonly name = 'qwen' as const;

	private _isInitialized = false;
	private runs = new EngineRuns<QwenRun>();

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	get isActive(): boolean {
		return this.runs.isActive;
	}

	async initialize(): Promise<void> {
		if (this._isInitialized) return;
		this._isInitialized = true;
		debug.log('engine', '✅ Qwen Code engine initialized');
	}

	async dispose(): Promise<void> {
		// Shutdown/retirement: every run on this instance goes.
		await this.stopRuns(this.runs.all());
		this._isInitialized = false;
	}

	/**
	 * Discover models dynamically against the active account's
	 * OpenAI-compatible `/models` endpoint. There is no static catalog —
	 * if no account is configured or the endpoint is unreachable, the
	 * picker shows an empty list (same contract Copilot follows on auth
	 * failure).
	 */
	async getAvailableModels(): Promise<EngineModel[]> {
		const env = getEngineEnv();
		if (!env) {
			throw new Error('Qwen Code is not configured. Add an API key in Settings → Engines → Qwen Code.');
		}
		const dynamic = await fetchQwenModels(env);
		debug.log('engine', `Qwen getAvailableModels: ${dynamic.length} models from ${env.preset}`);
		return dynamic;
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const {
			projectPath,
			prompt,
			resume,
			maxTurns,
			modelId,
			includePartialMessages = true,
			abortController,
			accountId,
		} = options;

		debug.log('chat', 'Qwen Code - Stream Query', { modelId, resume });

		const resolution = getEngineEnv(accountId);
		if (!resolution) {
			throw new Error('Qwen Code is not configured. Add an API key in Settings → Engines → Qwen Code.');
		}
		const { env } = resolution;

		const controller = abortController || new AbortController();
		const run: QwenRun = { controller, query: null, converter: null, pendingAskUserQuestion: null };
		this.runs.add(run);
		const resolvedProjectPath = resolveOsPath(projectPath);
		// Active Profile for this stream — scopes artifacts + connectors.
		const profileId = options.mcpContext?.profileId;
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		// Refresh the synthetic skills preamble in the Qwen memory file.
		await syncSkills('qwen', profileId);
		await syncEngineArtifacts('qwen', profileId);
		const mcpConfig = getQwenMcpConfig(mcpProfileFilter, options.mcpContext);

		// Resolve the permission policy once per stream; canUseTool enforces it
		// (Qwen otherwise auto-allows everything). Tool names arrive snake_cased.
		const permissions = resolvePermissionsFromDb('qwen', options.mcpContext?.projectId, profileId);

		// Fork-by-copy on EVERY resume — same semantics as Claude
		// (`forkSession: true`), OpenCode (`client.session.fork()`),
		// Copilot, and Codex (README §10.10): each turn must produce a
		// brand-new session id so the original branch's history is never
		// mutated and the multi-branch checkpoint tree stays consistent.
		// Falls through to a plain resume only when the source chat can't
		// be found on disk (best-effort recovery).
		//
		// TODO: replace with a native SDK fork call when @qwen-code/sdk
		// adds one. The block is the same one-liner Claude/OpenCode use.
		let resumeId = resume;
		if (resume && sessionStateExists(resolvedProjectPath, resume)) {
			const forkId = crypto.randomUUID();
			if (forkQwenSessionState(resolvedProjectPath, resume, forkId)) {
				resumeId = forkId;
				debug.log('engine', `Qwen resumed session: ${forkId} (forked from ${resume})`);
			}
		}

		// Capture the last few stderr lines from the bundled CLI so we can
		// surface them when the SDK reports a generic "CLI process exited
		// with code N" error. Otherwise the underlying cause (bad model,
		// bad endpoint, MCP timeout, …) is invisible to the user.
		const stderrLines: string[] = [];
		const STDERR_KEEP = 20;

		// Optional verbose SDK logging when CLOPEN_DEBUG_QWEN is set — useful
		// when shipping a build with sticky symptoms but no obvious cause.
		const verbose = !!process.env.CLOPEN_DEBUG_QWEN;

		try {
			const sdkOptions: QueryOptions = {
				cwd: resolvedProjectPath,
				model: modelId,
				env,
				// Force the bundled CLI onto the OpenAI-compatible auth path.
				// Without this the CLI falls back to `qwen-oauth` whenever it
				// finds residual OAuth state on disk (~/.qwen) and reports
				// "Qwen OAuth free tier was discontinued" even though we've
				// supplied OPENAI_API_KEY / OPENAI_BASE_URL.
				authType: 'openai',
				abortController: controller,
				includePartialMessages,
				stderr: (msg: string) => {
					const trimmed = msg.replace(/\s+$/, '');
					if (!trimmed) return;
					stderrLines.push(trimmed);
					if (stderrLines.length > STDERR_KEEP) stderrLines.shift();
					debug.warn('engine', 'qwen stderr:', trimmed);
				},
				...(verbose ? { logLevel: 'debug' as const, debug: true } : {}),
				// Lift the SDK's defaults: AskUserQuestion may legitimately
				// block the SDK indefinitely while the user thinks (Claude's
				// behaviour). MCP requests get a longer ceiling for slow
				// browser-automation calls. Other timeouts keep the default.
				//
				// `canUseTool` is the cap on how long we can hold the SDK
				// waiting for the user. The SDK feeds this to `setTimeout`,
				// which silently clamps any value > 2^31-1 ms down to 1 ms
				// (Node's TimeoutOverflowWarning) — that would auto-reject the
				// AUQ before the user could even see the dialog. ~24.8 days is
				// the practical maximum and is effectively unbounded for AUQ.
				timeout: {
					canUseTool: 2_147_483_647,
					mcpRequest: 600_000,
				},
				// 'default' lets `canUseTool` decide; non-write tools auto-execute.
				permissionMode: 'default',
				// Block `ask_user_question` at the SDK level — `excludeTools` has
				// the highest permission priority (see QueryOptions docs in the
				// SDK), so the tool is never advertised to the model and
				// `canUseTool` is never invoked for it.
				//
				// Why excluded: the Qwen SDK's stream-json
				// `handleOutgoingPermissionRequest` (cli.js:486478-486485) calls
				// `onConfirm(ProceedOnce)` WITHOUT forwarding the `updatedInput`
				// payload we resolve `canUseTool` with — so the user's `answers`
				// are dropped and the AUQ tool executes with `userAnswers: {}`,
				// emitting `"User has provided the following answers:\n\n"` and
				// closing the UI dialog before the user can respond. The
				// converter has a rewrite workaround (recordUserAnswer +
				// convertUserMessage interception) but it depends on a race
				// between the empty tool_result and `resolveUserAnswer` landing —
				// not reliable enough for production use.
				//
				// TODO(qwen-sdk): re-enable AUQ once the upstream SDK forwards
				// `updatedInput` from `canUseTool` into the tool execution
				// payload. Verify by checking `handleOutgoingPermissionRequest`
				// in the bundled CLI — when it stops calling
				// `onConfirm(ProceedOnce)` without the payload (or starts
				// passing the resolved `updatedInput`), drop this excludeTools
				// entry. The AUQ flow code (canUseTool handler, converter
				// state, resolveUserAnswer, recordUserAnswer) is intentionally
				// kept in place so reverting is a one-line change.
				// `canUseTool` (permissionMode 'default') only fires for WRITE tools,
				// so read-only tools can't be blocked there. `excludeTools` has the
				// highest permission priority, so denied/non-allowlisted built-ins are
				// hidden from the model entirely. MCP tools are filtered at the bridge.
				excludeTools: ['ask_user_question', ...excludedBuiltinTools(permissions, 'qwen')],
				canUseTool: async (toolName, input, ctx) => {
					// Qwen SDK passes the registered (snake_case) tool name here —
					// `ToolNames.ASK_USER_QUESTION = "ask_user_question"` — NOT the
					// canonical PascalCase form Claude uses. Comparing against
					// `'AskUserQuestion'` would silently fall through to auto-allow,
					// the SDK would then call `onConfirm(ProceedOnce)` without a
					// payload, and the AUQ tool would emit
					// `"User has provided the following answers:\n\n"` immediately
					// (empty `userAnswers`), closing the UI dialog before the user
					// has a chance to respond.
					if (toolName === 'ask_user_question') {
						return new Promise<PermissionResult>((resolve) => {
							if (ctx.signal.aborted) {
								resolve({ behavior: 'deny', message: 'Cancelled' });
								return;
							}
							const onAbort = () => {
								// Drop the slot WITHOUT resolving — same pattern as
								// Claude (see claude/stream.ts cancel()). Resolving
								// would prompt the SDK to write the result to a
								// subprocess that's about to die.
								run.pendingAskUserQuestion = null;
							};
							ctx.signal.addEventListener('abort', onAbort, { once: true });

							run.pendingAskUserQuestion = {
								resolve: (result) => {
									ctx.signal.removeEventListener('abort', onAbort);
									resolve(result);
								},
								removeAbortListener: () => ctx.signal.removeEventListener('abort', onAbort),
								input,
								toolUseId: null,
							};
						});
					}
					// Enforce the resolved permission policy before auto-allowing.
					if (!isToolAllowed(permissions, toolName)) {
						debug.log('permissions', `⛔ Blocked tool "${toolName}" (Clopen permission policy)`);
						return { behavior: 'deny' as const, message: `Blocked by Clopen permission policy: ${toolName}` };
					}
					// Auto-allow everything else.
					return { behavior: 'allow' as const, updatedInput: input };
				},
				...(maxTurns !== undefined ? { maxSessionTurns: maxTurns } : {}),
				...(resumeId ? { resume: resumeId } : {}),
				...(Object.keys(mcpConfig).length > 0 ? { mcpServers: mcpConfig } : {}),
			};

			const sdkPrompt = toSdkUserMessage(prompt);
			const promptIterable = (async function* (): AsyncIterable<SDKUserMessage> {
				yield sdkPrompt;
			})();

			const { query } = await loadEngineSdk<typeof import('@qwen-code/sdk')>('qwen', '@qwen-code/sdk');
			const queryInstance = query({ prompt: promptIterable, options: sdkOptions });
			run.query = queryInstance;

			const converter = createSdkMessageConverter(modelId, {
				onAskUserQuestionEmitted: (toolUseId: string) => {
					// canUseTool may fire before OR after the assistant message
					// containing the tool_use block — record either way. Keying
					// the pending slot here unblocks `resolveUserAnswer` even
					// when the frontend gets the toolUseId before our slot was
					// populated (rare but possible if the SDK queues events).
					if (run.pendingAskUserQuestion && run.pendingAskUserQuestion.toolUseId === null) {
						run.pendingAskUserQuestion.toolUseId = toolUseId;
					}
				},
			});
			run.converter = converter;
			for await (const sdkMessage of queryInstance) {
				yield* converter.convert(sdkMessage);
			}
		} catch (error) {
			handleStreamError(error, stderrLines.join('\n'));
		} finally {
			// Retire THIS run only — another chat session of the same project may
			// still be streaming on this instance.
			this.runs.remove(run);
		}
	}

	/**
	 * Cancel the run whose AbortController is `owner`, and only that run.
	 */
	async cancel(owner: AbortController): Promise<void> {
		await this.stopRuns(this.runs.select(owner));
	}

	/**
	 * Tear down the given runs. `cancel` passes the one run it was asked to
	 * stop; `dispose` passes them all. Nothing else may reach this.
	 */
	private async stopRuns(targets: QwenRun[]): Promise<void> {
		for (const run of targets) {
			// Drop this run's pending AskUserQuestion handler — same pattern as
			// Claude (don't resolve, just abandon, otherwise the SDK tries to write
			// to a subprocess that's about to die). Another run's parked question
			// is left alone; its subprocess is still alive and still waiting.
			if (run.pendingAskUserQuestion) {
				run.pendingAskUserQuestion.removeAbortListener();
				run.pendingAskUserQuestion = null;
			}

			if (run.query && typeof run.query.close === 'function') {
				try {
					await run.query.close();
				} catch {
					/* subprocess may already be dead */
				}
			}

			if (!run.controller.signal.aborted) run.controller.abort();
			this.runs.remove(run);
		}
	}

	async interrupt(owner: AbortController): Promise<void> {
		const targets = this.runs.select(owner);
		for (const run of targets) {
			if (run.query && typeof run.query.interrupt === 'function') {
				try {
					await run.query.interrupt();
				} catch {
					/* fall through to cancel */
				}
			}
		}
	}

	/**
	 * One-shot structured JSON generation via prompt engineering.
	 *
	 * The Qwen SDK has no native `outputSchema` / `response_format` option,
	 * so we instruct the model to emit JSON only, restrict tools with
	 * `coreTools: []`, and parse the final `result` text returned by the
	 * SDK's `SDKResultMessageSuccess`.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const {
			prompt,
			modelId,
			schema,
			projectPath,
			abortController,
			accountId,
		} = options;

		const resolution = getEngineEnv(accountId);
		if (!resolution) {
			throw new Error('Qwen Code is not configured. Add an API key in Settings → Engines → Qwen Code.');
		}
		const { env } = resolution;

		const controller = abortController || new AbortController();
		const resolvedProjectPath = resolveOsPath(projectPath);
		const jsonPrompt = buildJsonPrompt(prompt, schema);

		debug.log('engine', `[qwen structured] running with model=${modelId}`);

		const sdkOptions: QueryOptions = {
			cwd: resolvedProjectPath,
			model: modelId,
			env,
			authType: 'openai',
			abortController: controller,
			includePartialMessages: false,
			permissionMode: 'default',
			coreTools: [],
			maxSessionTurns: 1,
		};

		const sdkPrompt: SDKUserMessage = {
			type: 'user',
			uuid: crypto.randomUUID(),
			session_id: '',
			parent_tool_use_id: null,
			message: { role: 'user', content: jsonPrompt },
		};
		const promptIterable = (async function* (): AsyncIterable<SDKUserMessage> {
			yield sdkPrompt;
		})();

		const { query } = await loadEngineSdk<typeof import('@qwen-code/sdk')>('qwen', '@qwen-code/sdk');
		const queryInstance = query({ prompt: promptIterable, options: sdkOptions });

		let resultText = '';
		let errorMessage = '';
		try {
			for await (const message of queryInstance) {
				if (message.type === 'result') {
					if (message.subtype === 'success') {
						resultText = message.result || '';
					} else {
						errorMessage = message.error?.message || message.subtype || 'unknown error';
					}
				}
			}
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error('Generation was cancelled');
			}
			throw error;
		}

		if (!resultText) {
			throw new Error(errorMessage || 'Qwen returned no result text');
		}

		return extractJson<T>(resultText);
	}

	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		// Find the run that parked this question: the one that already recorded
		// this toolUseId, else the one still waiting for its id to arrive.
		const running = this.runs.all();
		const run = running.find(r => r.pendingAskUserQuestion?.toolUseId === toolUseId)
			?? running.find(r => r.pendingAskUserQuestion && r.pendingAskUserQuestion.toolUseId === null);
		const pending = run?.pendingAskUserQuestion ?? null;
		if (!run || !pending) {
			debug.warn('engine', 'Qwen resolveUserAnswer: no pending question');
			return false;
		}
		// Verify the toolUseId matches the one we recorded from the converter.
		// If we haven't seen the tool_use block yet (canUseTool fired first),
		// accept the answer and trust the frontend — only one question can be
		// pending at a time per SDK contract.
		if (pending.toolUseId !== null && pending.toolUseId !== toolUseId) {
			debug.warn('engine', `Qwen resolveUserAnswer: toolUseId mismatch (got ${toolUseId}, expected ${pending.toolUseId})`);
			return false;
		}

		// Push the answers into converter state FIRST so the rewrite is in
		// place by the time the SDK's broken AUQ tool_result arrives. The
		// SDK's `handleOutgoingPermissionRequest` calls `onConfirm(ProceedOnce)`
		// without a payload — `userAnswers` always ends up `{}` and the
		// tool_result body is `"User has provided the following answers:\n\n"`
		// (empty). The converter intercepts that tool_result and replaces its
		// content with the proper formatted answers we just stored.
		run.converter?.recordUserAnswer(toolUseId, answers);

		pending.resolve({
			behavior: 'allow',
			updatedInput: { ...pending.input, answers },
		});
		run.pendingAskUserQuestion = null;
		return true;
	}
}
