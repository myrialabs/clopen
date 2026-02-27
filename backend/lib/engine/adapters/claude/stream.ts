/**
 * Claude Code Engine Adapter
 *
 * Wraps the @anthropic-ai/claude-agent-sdk into the AIEngine interface.
 * Messages are already in SDKMessage format — no conversion needed.
 */


import { query, type SDKMessage, type EngineSDKMessage, type Options, type Query, type SDKUserMessage } from '$shared/types/messaging';
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { normalizePath } from './path-utils';
import { setupEnvironmentOnce, getEngineEnv } from './environment';
import { handleStreamError } from './error-handler';
import { getEnabledMcpServers, getAllowedMcpTools } from '../../../mcp';
import type { AIEngine, EngineQueryOptions } from '../../types';
import type { EngineModel } from '$shared/types/engine';
import { CLAUDE_CODE_MODELS } from '$shared/constants/engines';

import { debug } from '$shared/utils/logger';

/** Type guard for AsyncIterable */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

export class ClaudeCodeEngine implements AIEngine {
  readonly name = 'claude-code' as const;
  private _isInitialized = false;
  private activeController: AbortController | null = null;
  private activeQuery: Query | null = null;

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
      const mcpServers = getEnabledMcpServers();
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
    if (this.activeQuery && typeof this.activeQuery.interrupt === 'function') {
      try {
        await this.activeQuery.interrupt();
      } catch {
        // Ignore interrupt errors
      }
    }

    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
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
}
