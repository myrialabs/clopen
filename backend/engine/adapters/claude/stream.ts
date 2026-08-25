/**
 * Claude Code Engine Adapter
 *
 * Wraps the @anthropic-ai/claude-agent-sdk into the AIEngine interface.
 * SDK messages are converted to EngineOutput by ./message-converter.ts.
 *
 * Currently uses v1 query() API because v2 (unstable_v2_createSession) is
 * @alpha and lacks critical options required by Clopen:
 *   - cwd (multi-project working directory)
 *   - mcpServers, systemPrompt, settingSources
 *   - forkSession, maxTurns, abortController, includePartialMessages
 *   - outputFormat (needed by generateStructured)
 * When v2 SDKSessionOptions gains these, migrate streamQuery() to v2.
 */

import { loadEngineSdk } from '$backend/engine/sdk-loader';
import type {
	Options,
	Query,
	PermissionMode,
	PermissionResult,
	EffortLevel,
	HookInput,
	HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { EngineOutput } from '$shared/types/unified';
import type { StructuredGenerationOptions } from '../../types';
import { createSdkMessageConverter, toSdkUserMessage } from './message-converter';
import { WorkflowTranscriptTailer } from './workflow-transcript';
import { resolveOsPath } from '$backend/utils/paths';
import { setupEnvironmentOnce, getEngineEnv } from './environment';
import { handleStreamError } from './error-handler';
import { getEnabledMcpServers, getAllowedMcpTools } from '../../../mcp';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts } from '$backend/engine/artifact-sync';
import { artifactFilter } from '$backend/profiles';
import { resolvePermissionsFromDb, isToolAllowed, hasAnyRestriction, syncPermissions } from '$backend/permissions';
import type { AIEngine, EngineQueryOptions } from '../../types';
import { EngineRuns } from '../run-registry';
import type { EngineModel } from '$shared/types/unified';
import { CLAUDE_CODE_MODELS } from './models';

import { debug } from '$shared/utils/logger';

/** Pending AskUserQuestion resolver — stored while SDK is blocked waiting for user input */
interface PendingUserAnswer {
  resolve: (result: PermissionResult) => void;
  removeAbortListener: () => void;
  input: Record<string, unknown>;
  /** The run that asked — cancelling one run must not abandon another's questions. */
  run: ClaudeRun;
}

/**
 * One stream in flight on this instance. This engine instance is shared by every
 * chat session of a project, so the SDK query has to be held per run: a single
 * field holds only the most recently started stream, and cancelling any chat
 * would then close another chat's query.
 */
interface ClaudeRun {
  /** Identity of the run — the controller the caller passed to streamQuery. */
  controller: AbortController;
  query: Query | null;
}

/** Merge the SDK stream with Workflow transcript polling without blocking either producer. */
class EventQueue<T> {
  private buffer: T[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private error: unknown = null;

  push(value: T): void { this.buffer.push(value); this.signal(); }
  close(): void { this.done = true; this.signal(); }
  fail(error: unknown): void { this.error = error; this.done = true; this.signal(); }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<T, void, unknown> {
    while (true) {
      while (this.buffer.length) yield this.buffer.shift() as T;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export class ClaudeCodeEngine implements AIEngine {
  readonly name = 'claude-code' as const;
  private _isInitialized = false;
  private runs = new EngineRuns<ClaudeRun>();
  private pendingUserAnswers = new Map<string, PendingUserAnswer>();

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get isActive(): boolean {
    return this.runs.isActive;
  }

  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    // One-time environment setup (idempotent, concurrency-safe)
    await setupEnvironmentOnce();

    this._isInitialized = true;
    debug.log('engine', '✅ Claude Code engine initialized');
  }

  async dispose(): Promise<void> {
    // Shutdown/retirement: every run on this instance goes.
    await this.stopRuns(this.runs.all());
    this.pendingUserAnswers.clear();
    this._isInitialized = false;
  }

  async getAvailableModels(): Promise<EngineModel[]> {
    return CLAUDE_CODE_MODELS;
  }

  /**
   * Stream query, converting SDK messages → EngineOutput (unified types)
   */
  async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
    const {
      projectPath,
      prompt,
      resume,
      maxTurns = undefined,
      modelId,
      reasoningEffort,
      includePartialMessages = false,
      abortController,
      accountId
    } = options;

    // Map the chosen reasoning level to Claude's knobs: `off` disables thinking
    // entirely, `auto`/unset keeps adaptive thinking (Claude decides how much),
    // and an explicit effort level pairs adaptive thinking with `effort`.
    const claudeEffort = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
    const thinkingConfig: Options['thinking'] = reasoningEffort === 'off'
      ? { type: 'disabled' }
      : { type: 'adaptive', display: 'summarized' };
    const effortOption = reasoningEffort && claudeEffort.has(reasoningEffort)
      ? { effort: reasoningEffort as EffortLevel }
      : {};

    debug.log('chat', "Claude Code - Stream Query");
    debug.log('chat', { prompt });

    const streamController = abortController || new AbortController();
    const run: ClaudeRun = { controller: streamController, query: null };
    this.runs.add(run);

    const resolvedProjectPath = resolveOsPath(projectPath);

    try {
      // Active Profile for this stream (resolved in stream-manager). Scopes the
      // materialized artifact set + MCP connectors to the profile's bundle.
      const profileId = options.mcpContext?.profileId;
      const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;

      // Materialize enabled skills into Claude's native skills dir before the
      // session starts so the SDK picks them up via settingSources.
      await syncSkills('claude', profileId);
      // Commands, Subagents, and global Instructions share the same trigger.
      await syncEngineArtifacts('claude', profileId);
      // Mirror the resolved allow/deny into the isolated settings.json so the
      // rules are visible to anyone inspecting the config. Deny rules there do
      // bite even under bypassPermissions, but an allowlist has no on-disk
      // equivalent — the PreToolUse hook below is the authoritative enforcement.
      await syncPermissions('claude');

      // Resolve the effective permission policy once per stream. Enforcement
      // lives in the PreToolUse hook, NOT in canUseTool: under
      // permissionMode 'bypassPermissions' the CLI auto-approves a tool call
      // before the permission callback is consulted (the SDK says so itself via
      // the CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning), so a callback-side check
      // would be a no-op. A PreToolUse hook sees every call regardless of mode.
      const permissions = resolvePermissionsFromDb('claude-code', options.mcpContext?.projectId, profileId);
      // Registering the hook costs one control round-trip per tool call, so only
      // pay it when there is actually a rule to enforce.
      const enforcePermissions = hasAnyRestriction(permissions);

      // Get custom MCP servers and allowed tools
      // Pass mcpContext so tool handlers are bound to the correct project
      const mcpServers = await getEnabledMcpServers(options.mcpContext, mcpProfileFilter);
      const allowedMcpTools = getAllowedMcpTools();

      debug.log('mcp', '📦 Loading custom MCP servers...');
      debug.log('mcp', `Enabled servers: ${Object.keys(mcpServers).length}`);
      debug.log('mcp', `Allowed tools: ${allowedMcpTools.length}`);

      // AskUserQuestion safety net. The CLI still routes that tool through
      // canUseTool even under bypassPermissions, but the SDK explicitly
      // documents the callback as shadowed in that mode — so we rely on
      // behaviour upstream has not promised. If a future SDK stops routing it,
      // the question would never reach the user and the failure would be
      // silent; comparing what the model asked against what the callback parked
      // turns that into a log line instead of a frozen chat.
      const questionsAsked = new Set<string>();
      const questionsParked = new Set<string>();
      const observeAskUserQuestion = (sdkMessage: unknown): void => {
        const message = sdkMessage as { type?: string; message?: { content?: unknown } };
        if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return;
        for (const block of message.message.content as Array<{ type?: string; name?: string; id?: string }>) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id) {
            questionsAsked.add(block.id);
          }
        }
      };

      // SDK uses cwd from options — no process.chdir() needed.
      // Environment is passed via env option — no process.env mutation.
      // When accountId is specified, the env overrides the OAuth token
      // with that specific account's token instead of the globally active one.
      const sdkOptions: Options = {
        permissionMode: 'bypassPermissions' as PermissionMode,
        allowDangerouslySkipPermissions: true,
        cwd: resolvedProjectPath,
        env: getEngineEnv(accountId),
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        forkSession: true,
        // Reasoning level → thinking/effort (see thinkingConfig above). Adaptive
        // thinking with summarized display keeps Opus 4.6+ emitting visible
        // thinking_delta events; 'off' disables it, an explicit level adds effort.
        thinking: thinkingConfig,
        ...effortOption,
        // Tool gating that must survive every permission mode lives in the
        // PreToolUse hook below. This callback is kept for one job only: park
        // the SDK on AskUserQuestion until the user answers. It waits without a
        // deadline on purpose — a hook would be bounded by its `timeout`
        // (default 600000 ms, and values above 2^31-1 ms overflow setTimeout and
        // fire immediately), while a parked promise simply waits until the user
        // answers or the stream is cancelled.
        canUseTool: async (_toolName, input, canUseToolOptions) => {
          if (_toolName === 'AskUserQuestion') {
            debug.log('engine', `AskUserQuestion detected (toolUseID: ${canUseToolOptions.toolUseID}), waiting for user input...`);
            questionsParked.add(canUseToolOptions.toolUseID);
            return new Promise<PermissionResult>((resolve) => {
              // Handle abort (stream cancelled while waiting)
              if (canUseToolOptions.signal.aborted) {
                resolve({ behavior: 'deny', message: 'Cancelled' });
                return;
              }
              const onAbort = () => {
                this.pendingUserAnswers.delete(canUseToolOptions.toolUseID);
                resolve({ behavior: 'deny', message: 'Cancelled' });
              };
              canUseToolOptions.signal.addEventListener('abort', onAbort, { once: true });

              this.pendingUserAnswers.set(canUseToolOptions.toolUseID, {
                run,
                resolve: (result: PermissionResult) => {
                  canUseToolOptions.signal.removeEventListener('abort', onAbort);
                  resolve(result);
                },
                removeAbortListener: () => {
                  canUseToolOptions.signal.removeEventListener('abort', onAbort);
                },
                input
              });
            });
          }
          return { behavior: 'allow' as const, updatedInput: input };
        },
        // Enforce the resolved permission policy: deny blocks the tool, an
        // allowlist (when set) blocks anything not on it. Returning an empty
        // result leaves the decision alone, so unrestricted tools fall through
        // to the mode's own auto-approve without an extra round-trip.
        ...(enforcePermissions && {
          hooks: {
            PreToolUse: [{
              hooks: [async (hookInput: HookInput): Promise<HookJSONOutput> => {
                if (hookInput.hook_event_name !== 'PreToolUse') return {};
                // AskUserQuestion is Clopen's own interaction channel, not a
                // capability the policy is about — it was exempt while the check
                // lived in canUseTool (that branch returned first), so an
                // allowlist must not start silencing questions now.
                if (hookInput.tool_name === 'AskUserQuestion') return {};
                if (isToolAllowed(permissions, hookInput.tool_name)) return {};
                debug.log('permissions', `⛔ Blocked tool "${hookInput.tool_name}" (Clopen permission policy)`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `Blocked by Clopen permission policy: ${hookInput.tool_name}`
                  }
                };
              }]
            }]
          }
        }),
        ...(modelId && { model: modelId }),
        ...(resume && { resume }),
        ...(maxTurns && { maxTurns }),
        ...(includePartialMessages && { includePartialMessages }),
        forwardSubagentText: true,
        abortController: streamController,
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        ...(allowedMcpTools.length > 0 && { allowedTools: allowedMcpTools })
      };

      // Convert UserMessage → SDKUserMessage for SDK
      const sdkPrompt = toSdkUserMessage(prompt);
      const promptIterable = (async function* () {
        yield sdkPrompt;
      })();

      const { query } = await loadEngineSdk<typeof import('@anthropic-ai/claude-agent-sdk')>('claude-code', '@anthropic-ai/claude-agent-sdk');
      const queryInstance = query({
        prompt: promptIterable,
        options: sdkOptions,
      });

      run.query = queryInstance;

      // Per-query stateful converter so block-stop reasoning tracking persists
      // across the stream of SDK messages.
      const convertSdkMessage = createSdkMessageConverter();
      const workflowTranscripts = new WorkflowTranscriptTailer();
      const events = new EventQueue<EngineOutput>();
      let sdkStreamDone = false;

      const sdkProducer = (async () => {
        try {
          for await (const sdkMessage of queryInstance) {
            observeAskUserQuestion(sdkMessage);
            // Register Workflow launches after queueing the corresponding parent
            // and tool result, preserving their ordering ahead of child records.
            for (const output of convertSdkMessage(sdkMessage)) events.push(output);
            workflowTranscripts.observe(sdkMessage);
          }
        } finally {
          sdkStreamDone = true;
          workflowTranscripts.wake();
        }
      })();

      const transcriptProducer = (async () => {
        while (true) {
          const observedVersion = workflowTranscripts.changeVersion;
          for (const output of await workflowTranscripts.drain()) events.push(output);

          if (streamController.signal.aborted) break;
          if (sdkStreamDone && !await workflowTranscripts.hasActiveWorkflows()) break;
          await workflowTranscripts.waitForChange(observedVersion, streamController.signal);
        }
        // The terminal status event is authoritative; drain once more for writes
        // already queued by the filesystem before closing the merged stream.
        for (const output of await workflowTranscripts.drain()) events.push(output);
      })();

      const producers = Promise.all([sdkProducer, transcriptProducer]);
      void producers.then(() => events.close(), error => events.fail(error));
      try {
        yield* events.drain();
        await producers;
      } finally {
        workflowTranscripts.dispose();
        // A cancelled stream legitimately leaves questions unparked.
        if (!streamController.signal.aborted) {
          const unrouted = [...questionsAsked].filter(id => !questionsParked.has(id));
          if (unrouted.length > 0) {
            debug.error('engine', `AskUserQuestion never reached canUseTool (${unrouted.length}: ${unrouted.join(', ')}). The SDK likely stopped routing that tool through the permission callback under bypassPermissions — interactive questions are now unanswerable and must move to a PreToolUse hook.`);
          }
        }
      }

    } catch (error) {
      handleStreamError(error);
    } finally {
      // Retire THIS run only — a concurrent stream of another chat session in
      // the same project is still using the instance.
      this.forgetRun(run);
    }
  }

  /**
   * Drop a finished run and the questions only it could have answered.
   */
  private forgetRun(run: ClaudeRun): void {
    this.runs.remove(run);
    for (const [toolUseId, pending] of this.pendingUserAnswers) {
      if (pending.run === run) this.pendingUserAnswers.delete(toolUseId);
    }
    run.query = null;
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
  private async stopRuns(targets: ClaudeRun[]): Promise<void> {
    for (const run of targets) {
      // Remove abort listeners from this run's pending AskUserQuestion promises
      // WITHOUT resolving them. Resolving causes the SDK to call
      // handleControlRequest → write() to send the permission result to the
      // subprocess. If close() has already killed the subprocess, this write
      // throws "Operation aborted" as an unhandled error, crashing the server.
      // By removing listeners and not resolving, the promises are safely
      // abandoned when close() terminates the process and the async generator
      // completes. Questions parked by OTHER runs stay put — their subprocess
      // is still alive and still waiting for an answer.
      for (const [, pending] of this.pendingUserAnswers) {
        if (pending.run === run) pending.removeAbortListener();
      }

      // Use close() to forcefully terminate the query process and clean up
      // all resources (docs: "Forcefully ends the query and cleans up all
      // resources"). Unlike interrupt() which can hang indefinitely when the
      // subprocess is unresponsive, close() is synchronous and guaranteed to
      // complete — making cancel deterministic.
      if (run.query && typeof run.query.close === 'function') {
        try {
          run.query.close();
        } catch {
          // Ignore close errors — process may already be dead
        }
      }

      if (!run.controller.signal.aborted) run.controller.abort();
      this.forgetRun(run);
    }
  }

  /**
   * Interrupt a run (soft stop). Targeted like `cancel`.
   */
  async interrupt(owner: AbortController): Promise<void> {
    const targets = this.runs.select(owner);
    for (const run of targets) {
      if (run.query && typeof run.query.interrupt === 'function') {
        await run.query.interrupt();
      }
    }
  }

  /**
   * Change permission mode for one run's query.
   */
  async setPermissionMode(mode: PermissionMode, owner: AbortController): Promise<void> {
    for (const run of this.runs.select(owner)) {
      if (run.query && typeof run.query.setPermissionMode === 'function') {
        await run.query.setPermissionMode(mode);
      }
    }
  }

  /**
   * Resolve a pending AskUserQuestion by providing the user's answers.
   * This unblocks the canUseTool callback, allowing the SDK to continue.
   */
  resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingUserAnswers.get(toolUseId);
    if (!pending) {
      debug.warn('engine', 'resolveUserAnswer: No pending question for toolUseId:', toolUseId);
      return false;
    }

    debug.log('engine', `Resolving AskUserQuestion (toolUseID: ${toolUseId})`);

    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers
      }
    });

    this.pendingUserAnswers.delete(toolUseId);
    return true;
  }

  /**
   * One-shot structured JSON generation.
   * Uses query() with no tools, outputFormat, and maxTurns: 1.
   */
  async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
    const {
      prompt,
      modelId,
      schema,
      projectPath,
      abortController,
      accountId
    } = options;

    if (!this._isInitialized) {
      await this.initialize();
    }

    const controller = abortController || new AbortController();
    const resolvedPath = resolveOsPath(projectPath);

    // Optimized for one-shot structured generation:
    // - tools: [] prevents tool use (no agentic loops)
    // - persistSession: false skips writing session to disk
    // - effort: 'low' reduces processing overhead for simple tasks
    // - thinking disabled removes reasoning overhead
    // - minimal systemPrompt avoids loading heavy defaults
    // - no maxTurns: structured output has its own retry limit
    const sdkOptions: Options = {
      permissionMode: 'bypassPermissions' as PermissionMode,
      allowDangerouslySkipPermissions: true,
      cwd: resolvedPath,
      env: getEngineEnv(accountId),
      systemPrompt: 'You are a structured data generator. Return JSON matching the provided schema.',
      tools: [],
      outputFormat: {
        type: 'json_schema',
        schema
      },
      persistSession: false,
      effort: 'low',
      thinking: { type: 'disabled' },
      ...(modelId && { model: modelId }),
      abortController: controller
    };

    // Use plain string prompt — simpler and faster than AsyncIterable
    const { query } = await loadEngineSdk<typeof import('@anthropic-ai/claude-agent-sdk')>('claude-code', '@anthropic-ai/claude-agent-sdk');
    const queryInstance = query({
      prompt,
      options: sdkOptions
    });

    let structuredOutput: unknown = null;
    let resultText = '';
    let lastError = '';

    try {
      for await (const message of queryInstance) {
        debug.log('engine', `[structured] message type=${message.type}, subtype=${'subtype' in message ? message.subtype : 'n/a'}`);

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const result = message as any;
            structuredOutput = result.structured_output;
            resultText = result.result || '';
            debug.log('engine', `[structured] success: structured_output=${!!structuredOutput}, resultLen=${resultText.length}`);
          } else {
            const errResult = message as any;
            lastError = errResult.errors?.join('; ') || '';
            const subtype = errResult.subtype || '';

            // Map SDK error subtypes to user-friendly messages
            if (subtype === 'error_max_structured_output_retries') {
              lastError = 'Failed to generate valid structured output after multiple attempts';
            } else if (subtype === 'error_max_turns') {
              lastError = 'Generation exceeded turn limit';
            } else if (!lastError) {
              lastError = subtype || 'unknown error';
            }

            debug.error('engine', `[structured] result error: ${lastError}`);
          }
        }
      }
    } catch (error) {
      handleStreamError(error);
      // handleStreamError swallows AbortError — if we reach here without throw, it was cancelled
      throw new Error('Generation was cancelled');
    }

    if (structuredOutput) {
      return structuredOutput as T;
    }

    // Fallback: parse the text result as JSON
    if (resultText) {
      try {
        return JSON.parse(resultText) as T;
      } catch {
        debug.warn('engine', `[structured] result text is not valid JSON: ${resultText.slice(0, 200)}`);
      }
    }

    throw new Error(lastError || 'Claude Code did not return valid structured output');
  }
}
