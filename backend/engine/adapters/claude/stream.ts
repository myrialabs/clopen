/**
 * Claude Code Engine Adapter
 *
 * Wraps the @anthropic-ai/claude-agent-sdk into the AIEngine interface.
 * Messages are already in SDKMessage format — no conversion needed.
 */


import { query, type SDKMessage, type EngineSDKMessage, type Options, type Query, type SDKUserMessage } from '$shared/types/messaging';
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { StructuredGenerationOptions } from '../../types';
import { normalizePath } from './path-utils';
import { setupEnvironmentOnce, getEngineEnv } from './environment';
import { handleStreamError } from './error-handler';
import { getEnabledMcpServers, getAllowedMcpTools } from '../../../mcp';
import type { AIEngine, EngineQueryOptions } from '../../types';
import type { EngineModel } from '$shared/types/engine';
import { CLAUDE_CODE_MODELS } from '$shared/constants/engines';

import { debug } from '$shared/utils/logger';

/** Pending AskUserQuestion resolver — stored while SDK is blocked waiting for user input */
interface PendingUserAnswer {
  resolve: (result: PermissionResult) => void;
  removeAbortListener: () => void;
  input: Record<string, unknown>;
}

/** Type guard for AsyncIterable */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

export class ClaudeCodeEngine implements AIEngine {
  readonly name = 'claude-code' as const;
  private _isInitialized = false;
  private activeController: AbortController | null = null;
  private activeQuery: Query | null = null;
  private pendingUserAnswers = new Map<string, PendingUserAnswer>();

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get isActive(): boolean {
    return this.activeController !== null;
  }

  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    // One-time environment setup (idempotent, concurrency-safe)
    await setupEnvironmentOnce();

    this._isInitialized = true;
    debug.log('engine', '✅ Claude Code engine initialized');
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.pendingUserAnswers.clear();
    this._isInitialized = false;
  }

  async getAvailableModels(): Promise<EngineModel[]> {
    return CLAUDE_CODE_MODELS;
  }

  /**
   * Stream query with real-time callbacks
   */
  async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineSDKMessage, void, unknown> {
    const {
      projectPath,
      prompt,
      resume,
      maxTurns = undefined,
      model = 'sonnet',
      includePartialMessages = false,
      abortController,
      claudeAccountId
    } = options;

    debug.log('chat', "Claude Code - Stream Query");
    debug.log('chat', { prompt });

    this.activeController = abortController || new AbortController();

    const normalizedProjectPath = normalizePath(projectPath);

    try {
      // Get custom MCP servers and allowed tools
      // Pass mcpContext so tool handlers are bound to the correct project
      const mcpServers = getEnabledMcpServers(options.mcpContext);
      const allowedMcpTools = getAllowedMcpTools();

      debug.log('mcp', '📦 Loading custom MCP servers...');
      debug.log('mcp', `Enabled servers: ${Object.keys(mcpServers).length}`);
      debug.log('mcp', `Allowed tools: ${allowedMcpTools.length}`);

      // SDK uses cwd from options — no process.chdir() needed.
      // Environment is passed via env option — no process.env mutation.
      // When claudeAccountId is specified, the env uses that account's token
      // instead of the globally active account.
      const sdkOptions: Options = {
        permissionMode: 'bypassPermissions' as PermissionMode,
        allowDangerouslySkipPermissions: true,
        cwd: normalizedProjectPath,
        env: getEngineEnv(claudeAccountId),
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        forkSession: true,
        // Custom permission handler: blocks on AskUserQuestion until user answers,
        // auto-allows everything else. Works alongside bypassPermissions.
        canUseTool: async (_toolName, input, options) => {
          if (_toolName === 'AskUserQuestion') {
            debug.log('engine', `AskUserQuestion detected (toolUseID: ${options.toolUseID}), waiting for user input...`);
            return new Promise<PermissionResult>((resolve) => {
              // Handle abort (stream cancelled while waiting)
              if (options.signal.aborted) {
                resolve({ behavior: 'deny', message: 'Cancelled' });
                return;
              }
              const onAbort = () => {
                this.pendingUserAnswers.delete(options.toolUseID);
                resolve({ behavior: 'deny', message: 'Cancelled' });
              };
              options.signal.addEventListener('abort', onAbort, { once: true });

              this.pendingUserAnswers.set(options.toolUseID, {
                resolve: (result: PermissionResult) => {
                  options.signal.removeEventListener('abort', onAbort);
                  resolve(result);
                },
                removeAbortListener: () => {
                  options.signal.removeEventListener('abort', onAbort);
                },
                input
              });
            });
          }
          // Auto-allow all other tools
          return { behavior: 'allow' as const, updatedInput: input };
        },
        ...(model && { model }),
        ...(resume && { resume }),
        ...(maxTurns && { maxTurns }),
        ...(includePartialMessages && { includePartialMessages }),
        abortController: this.activeController,
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        ...(allowedMcpTools.length > 0 && { allowedTools: allowedMcpTools })
      };

      // Create async iterable from single message if needed
      let promptIterable: AsyncIterable<SDKUserMessage>;

      if (isAsyncIterable<SDKUserMessage>(prompt)) {
        promptIterable = prompt;
      } else {
        promptIterable = (async function* () {
          yield prompt as SDKUserMessage;
        })();
      }

      const queryInstance = query({
        prompt: promptIterable,
        options: sdkOptions,
      });

      this.activeQuery = queryInstance;

      for await (const message of queryInstance) {
        yield message;
      }

    } catch (error) {
      handleStreamError(error);
    } finally {
      this.activeController = null;
      this.activeQuery = null;
    }
  }

  /**
   * Cancel active query
   */
  async cancel(): Promise<void> {
    // Remove abort listeners from pending AskUserQuestion promises WITHOUT
    // resolving them. Resolving causes the SDK to call handleControlRequest →
    // write() to send the permission result to the subprocess. If close() has
    // already killed the subprocess, this write throws "Operation aborted" as
    // an unhandled error, crashing the server. By removing listeners and not
    // resolving, the promises are safely abandoned when close() terminates the
    // process and the async generator completes.
    for (const [, pending] of this.pendingUserAnswers) {
      pending.removeAbortListener();
    }
    this.pendingUserAnswers.clear();

    // Use close() to forcefully terminate the query process and clean up
    // all resources (docs: "Forcefully ends the query and cleans up all
    // resources"). Unlike interrupt() which can hang indefinitely when the
    // subprocess is unresponsive, close() is synchronous and guaranteed to
    // complete — making cancel deterministic.
    if (this.activeQuery && typeof this.activeQuery.close === 'function') {
      try {
        this.activeQuery.close();
      } catch {
        // Ignore close errors — process may already be dead
      }
    }

    if (this.activeController && !this.activeController.signal.aborted) {
      this.activeController.abort();
    }
    this.activeController = null;
    this.activeQuery = null;
  }

  /**
   * Interrupt the active query
   */
  async interrupt(): Promise<void> {
    if (this.activeQuery && typeof this.activeQuery.interrupt === 'function') {
      await this.activeQuery.interrupt();
    }
  }

  /**
   * Change permission mode for active query
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.activeQuery && typeof this.activeQuery.setPermissionMode === 'function') {
      await this.activeQuery.setPermissionMode(mode);
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
      model = 'haiku',
      schema,
      projectPath,
      abortController,
      claudeAccountId
    } = options;

    if (!this._isInitialized) {
      await this.initialize();
    }

    const controller = abortController || new AbortController();
    const normalizedPath = normalizePath(projectPath);

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
      cwd: normalizedPath,
      env: getEngineEnv(claudeAccountId),
      systemPrompt: 'You are a structured data generator. Return JSON matching the provided schema.',
      tools: [],
      outputFormat: {
        type: 'json_schema',
        schema
      },
      persistSession: false,
      effort: 'low',
      thinking: { type: 'disabled' },
      ...(model && { model }),
      abortController: controller
    };

    // Use plain string prompt — simpler and faster than AsyncIterable
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
