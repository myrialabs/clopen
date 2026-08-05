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

Four invariants:

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
4. **`generateStructured` callers resolve their target first.** The
   `providerSlug` a client hands to a one-shot JSON call is a *hint*, not
   truth — every call site pipes it through
   `resolveGenerationTarget(engine, modelId, providerHint)`
   (`backend/engine/resolve-model.ts`) and uses what comes back. The engine's
   own catalog is the only source of truth for which provider (and account) a
   model belongs to. Skipping this "works" on the five engines that ignore the
   slug and fails on OpenCode, Pi, and Cline. See §10.16 point 3.

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

#### Parent-tool activity contract (`Agent` / `Workflow`)

Nested activity is still ordinary `AssistantMessage` / `UserMessage` output;
its placement is determined by `message.parent.toolUseId`.

The following invariants are mandatory:

1. Emit the parent tool message before any child activity.
2. Set every child message's `parent.toolUseId` to the parent tool call id
   before yielding it. Never emit a root-shaped child and patch it later.
3. Keep top-level tool results at `parent.toolUseId = null`; the id of the tool
   they answer belongs on the inner `tool_result.toolUseId`.
4. Do not forward nested text/reasoning `stream_event` deltas unless the
   protocol can carry their parent id. Suppress them and emit the finalized
   parent-tagged message instead.
5. When activity comes from a side channel, merge it with the SDK stream using
   a push queue. Use the source's native notification mechanism (for example
   filesystem change events for JSONL transcripts), not interval polling.
6. Preserve source timestamps and byte/file offsets so events retain their
   actual order and are emitted exactly once.
7. Keep the merged stream open until the parent run reports a terminal status,
   then perform one final drain and release watchers/listeners on success,
   cancellation, and error.

The frontend groups parent-tagged messages directly into `subActivities`.
They must never claim a root `stream_event` placeholder; doing so produces a
visible root-to-child jump even though the persisted DB relation is correct.
See §10.15 and frontend-and-chat §6.5.

### 2.4 `EngineQueryOptions`

```ts
interface EngineQueryOptions {
  projectPath: string;
  prompt: UserMessage;
  resume?: string;              // SDK session id for resume / fork
  forkSession?: boolean;
  maxTurns?: number;
  providerSlug: string;         // 'anthropic', 'openai', etc — required for opencode
  modelId: string;              // 'claude-opus-5', 'gpt-5', etc
  reasoningEffort?: string;     // native reasoning/thinking level for this turn
  includePartialMessages?: boolean;
  abortController?: AbortController;
  accountId?: number;           // override credential for a single stream
  mcpContext?: McpExecutionContext; // { projectId, chatSessionId, streamId }
}
```

`mcpContext` is bound into the MCP handler so a tool call from project A
**cannot** write into project B. Always forward it: see `claude/stream.ts`
calling `getEnabledMcpServers(options.mcpContext)`.

`reasoningEffort` is an **opaque, native-per-engine token** — there is no
cross-engine normalization. The adapter that produced the level in
`models.ts` is the one that consumes it in `stream.ts`; every other layer
(stream-manager, WS, frontend) just carries the string. `undefined` means
"no explicit choice" → the engine's own default applies. See §2.4a.

### 2.4a Reasoning effort — `EngineModel.capabilities.reasoningControl`

A model may advertise a reasoning/thinking control from its `models.ts`:

```ts
interface ReasoningControl {
  levels: { value: string; label: string }[];  // ordered low → high
  default: string;                             // mirrors the engine default
}
```

Rules:

- **Capability-driven, not hardcoded.** The picker renders a level selector
  **only** when the selected model carries `capabilities.reasoningControl`.
  Omit the field and the UI hides the control entirely — that is how Qwen,
  OpenCode, and Cline stay knob-less without a single `if (engine === …)`
  anywhere in the frontend.
- **Levels are the SDK's own vocabulary.** Don't invent a shared
  `low|medium|high` scale. Use `toReasoningOptions([...])` from
  `$shared/constants/engines` to attach labels; `reasoningLevelLabel()` maps the
  known tokens (`off`, `auto`/`adaptive`, `minimal` … `max`) and capitalizes
  anything it doesn't recognise.
- **Derive from the catalog when the SDK reports it.** Copilot reads
  `supportedReasoningEfforts` / `defaultReasoningEffort` off `ModelInfo`, Pi
  reads `getSupportedThinkingLevels(model)`, Cursor reads the model's
  `ModelParameterDefinition`. Only static catalogs (Claude, Codex) hardcode
  the list.
- **The adapter clamps.** `streamQuery` must treat the incoming token as
  untrusted — an unknown/stale value falls back to the engine default rather
  than being forwarded to the SDK.

Where each engine's knob lives:

| Engine        | SDK knob                                | Levels                                     |
|---------------|-----------------------------------------|--------------------------------------------|
| `claude-code` | `thinking` + `effort` on `query()`      | `off, auto, low, medium, high, xhigh, max` (static; `off` → `thinking: { type: 'disabled' }`, `auto` → adaptive with no `effort`) |
| `codex`       | `modelReasoningEffort` (thread option)  | `minimal, low, medium, high, xhigh` (static; reasoning-capable models only) |
| `copilot`     | `SessionConfig.reasoningEffort`         | from `ModelInfo.supportedReasoningEfforts` (dynamic) |
| `pi`          | agent `thinkingLevel`                   | from `getSupportedThinkingLevels(model)` (dynamic; `clampThinkingLevel` on apply) |
| `cursor`      | `ModelSelection.params[]`               | from the model's reasoning-ish `ModelParameterDefinition` (dynamic) |
| `qwen`, `opencode`, `cline` | — (none exposed)          | no `reasoningControl` → selector hidden    |

Cursor is the one engine whose token is **not** a bare level: it encodes the
model-parameter id as `"<paramId>::<value>"` so `stream.ts` can rebuild a
`ModelSelection.params` entry without re-fetching the catalog. If a future SDK
needs more than a level name, follow that shape rather than adding a new field
to `EngineQueryOptions`.

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
