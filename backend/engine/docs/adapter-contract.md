[← Engine adapter guide](../README.md)

## 2. The `backend/engine/` layer — core contract

### 2.1 `types.ts` — the `AIEngine` interface

```ts
export interface AIEngine {
  readonly name: EngineType;          // 'claude-code' | 'opencode' | 'copilot'
  readonly isInitialized: boolean;
  readonly isActive: boolean;

  initialize(accountId?: number): Promise<void>;  // lazy; idempotent
  dispose(): Promise<void>;           // called per-project & on shutdown
  cancel(): Promise<void>;            // hard cancel
  interrupt(): Promise<void>;         // soft stop

  streamQuery(options: EngineQueryOptions):
    AsyncGenerator<EngineOutput, void, unknown>;

  getAvailableModels(): Promise<EngineModel[]>;

  // Optional
  resolveUserAnswer?(toolUseId: string, answers: Record<string,string>): boolean;
  generateStructured?<T>(options: StructuredGenerationOptions): Promise<T>;
}
```

Three invariants:

1. **`streamQuery` is the only streaming output path.** It is an
   `AsyncGenerator<EngineOutput>`. The adapter translates SDK events into
   `EngineOutput` — that is all.
2. **Streaming state lives on the instance.** Because `getProjectEngine`
   returns one instance per `(projectId, engineType)`, the abort controller,
   active query, `pendingUserAnswers`, and session ID are automatically
   isolated per-project.
3. **Init is lazy & concurrency-safe.** The first `streamQuery` /
   `getAvailableModels` call triggers `initialize()`. Multiple parallel
   callers **must** share a single init promise. See:
   - `claude/environment.ts::setupEnvironmentOnce`
   - `opencode/server.ts::ensureClient`

### 2.2 `index.ts` — registry & lifecycle

Two instance tiers:

| Tier               | Factory                       | Used for                                  |
|--------------------|-------------------------------|-------------------------------------------|
| Global singleton   | `getEngine(type)`             | Non-streaming ops: `models:list`, settings|
| Per-project        | `getProjectEngine(projectId, type)` | Streaming chat — isolated per-project|

Cleanup:
- `disposeProjectEngines(projectId)` when a project closes.
- `disposeAllEngines()` at server shutdown — also calls
  `disposeOpenCodeClient()`. Pattern: when an adapter owns a shared
  subprocess, expose `disposeXxxClient()` from `adapters/<name>/index.ts`
  and call it from `disposeAllProjectEngines()` in `index.ts`.

### 2.3 `EngineOutput` — the event contract

In `shared/types/unified/stream.ts`:

```ts
type EngineOutput =
  | UserMessage          // persisted to DB
  | AssistantMessage     // persisted to DB
  | ReasoningMessage     // persisted to DB
  | CompactBoundaryMessage
  | StreamEvent          // transient: 'start' | 'stop' | 'delta'
  | ResultEvent          // transient: success / error_max_turns / etc.
  | SystemInitEvent      // transient: model + tools + mcpServers
  | RateLimitEvent;      // transient
```

`stream-manager.ts` discriminates on `output.type`:

| `type`         | Routing                                                 |
|----------------|---------------------------------------------------------|
| `user`/`assistant`/`reasoning`/`compact_boundary` | save DB + emit `chat:message` |
| `stream_event` | forward to frontend for live typing (`chat:partial`)   |
| `result`       | extract metadata + emit `chat:stream-finished`          |
| `system_init`  | emit MCP-failure notification if any                    |
| `rate_limit`   | emit `chat:notification`                                |

> **Strict rule:** do not invent new types. If an SDK has an event that
> needs to be propagated, **extend** the union in
> `shared/types/unified/stream.ts` first, teach `stream-manager` how to
> route it, and only then emit it from the adapter.

### 2.4 `EngineQueryOptions`

```ts
interface EngineQueryOptions {
  projectPath: string;
  prompt: UserMessage;
  resume?: string;              // SDK session id for resume / fork
  forkSession?: boolean;
  maxTurns?: number;
  providerSlug: string;         // 'anthropic', 'openai', etc — required for opencode
  modelId: string;              // 'claude-opus-4-7', 'gpt-5', etc
  includePartialMessages?: boolean;
  abortController?: AbortController;
  accountId?: number;           // override credential for a single stream
  mcpContext?: McpExecutionContext; // { projectId, chatSessionId, streamId }
}
```

`mcpContext` is bound into the MCP handler so a tool call from project A
**cannot** write into project B. Always forward it: see `claude/stream.ts`
calling `getEnabledMcpServers(options.mcpContext)`.

### 2.5 What an adapter **MUST NOT** do

- ❌ Call `ws.emit.*` — that is the stream-manager's job.
- ❌ Touch chat / message DB (`messageQueries`, `sessionQueries`) —
  persistence belongs to the stream-manager. Adapters **may** read
  credentials via `engineQueries`.
- ❌ Mutate `process.env` or call `process.chdir()` — pass env & cwd via
  SDK options. Many projects stream concurrently.
- ❌ Define shared types inline — extend `shared/types/unified/*`.
- ❌ Use `console.*` — use `debug` from `$shared/utils/logger` with
  category `'engine'`, `'chat'`, or `'mcp'`.
- ❌ **Build a new MCP HTTP server for the adapter.** Use the existing
  `backend/mcp/internal/remote-server.ts` and add a `getXxxMcpConfig()` helper in
  `backend/mcp/internal/config.ts` returning the URL in the engine's expected
  shape. New MCP servers are added via `defineServer()` — never via a
  parallel HTTP listener.
- ❌ **Create per-account isolated home directories** to multiplex two
  accounts into the same CLI's shared dotfile. Snapshot the CLI's auth
  file into `engine_accounts.credential` on login; write the chosen
  account's snapshot back into the shared location on switch. See §10.13.

### 2.6 Standard files in each adapter

Adapters follow a fixed file taxonomy. **Mandatory** files exist in every
adapter; **optional** files may be omitted, but when present they MUST use
the canonical name below — never a synonym (`auth.ts`, `provider-catalog.ts`,
etc.). This keeps `git grep` and the README's quick-reference rows usable.

```
adapters/<name>/
├── index.ts                ← MANDATORY  re-exports only, NO logic
├── stream.ts               ← MANDATORY  class implements AIEngine
├── models.ts               ← MANDATORY  static EngineModel[] OR dynamic fetcher
├── message-converter.ts    ← MANDATORY  SDK message → EngineOutput (pure)
├── error-handler.ts        ← MANDATORY  SDK error → user-facing string
├── credential.ts?          ← OPTIONAL   credential parse / auth-blob swap (codex, qwen)
├── environment.ts?         ← OPTIONAL   env / dotfile setup (claude, qwen)
├── server.ts?              ← OPTIONAL   subprocess + client lifecycle (opencode)
├── config.ts?              ← OPTIONAL   runtime config builder (opencode)
├── presets.ts?             ← OPTIONAL   multi-provider/region preset catalog (qwen, opencode)
└── session-fork.ts?        ← OPTIONAL   on-disk session fork workaround (codex, qwen)
```

Naming rules — strict, even when an SDK's local jargon differs:

| File              | Owns                                                                  |
|-------------------|-----------------------------------------------------------------------|
| `credential.ts`   | Parse `engine_accounts.credential` (JSON wrapper or raw key); for shared-CLI engines, materialise the auth-blob into the dotfile and snapshot it back. **Never** name this `auth.ts` — credentials are the unified concept (see §10.13). |
| `error-handler.ts`| Export `handleStreamError(error: unknown, ...): void` that swallows abort errors and re-throws everything else as a sanitised `Error`. Required even when the body is short — `OpenCodeEngine` previously inlined ~50 lines into the catch block; that pattern is no longer accepted. |
| `presets.ts`      | Multi-provider/region picker catalog (Qwen's DashScope/OpenRouter/Fireworks; OpenCode's models.dev cache). Multi-provider engines that lacked a `presets.ts` (OpenCode used to call this `config.ts`) have been migrated. |
| `config.ts`       | Runtime config builder ONLY — turning DB providers + accounts into env vars / spawn options. Catalog data goes in `presets.ts`. |

Important conventions:
- `message-converter.ts` is generally pure. If you need per-stream state
  (e.g. tracking "is the reasoning block already closed?"), expose a
  **factory** `createSdkMessageConverter()` returning a stateful converter
  — see Claude.
- Tool names **must** be canonicalised via `toCanonicalToolName(...)`
  (`shared/types/unified/tool.ts`) so the frontend renders the same UI for
  tools that have different names across SDKs.
- `cancel()` ordering: **abort the local controller first**, **then** RPC
  to the SDK/server. RPCs can hang; the local abort cuts the `for await`
  loop deterministically. See `OpenCodeEngine.cancel`,
  `ClaudeCodeEngine.cancel`, `CopilotEngine.cancel`.
- Dynamic-catalog fetchers in `models.ts` MUST return `EngineModel[]` and
  use `[]` as the failure sentinel (network, auth, parse error). Do **not**
  return `null` — both `fetchOpenCodeModels` and `fetchQwenModels` return
  `[]` on failure so the picker renders empty rather than a stale catalog.
- `stream.ts` materialises the user's artifacts at stream start: call
  `syncSkills(...)` then `syncEngineArtifacts(...)` (and, for prompt-scoped
  engines, prepend `buildArtifactsPromptContext(...)` to the prompt) from
  `backend/engine/artifact-sync.ts`. These are shared helpers, **not** files in
  the per-adapter taxonomy — the adapter only calls them. See §8.3.

---

