# `backend/engine/` — End-to-End Adapter Guide

This folder is the **boundary** between Clopen and the AI SDKs that drive
streaming chat. Today there are three adapters: **`claude`**
(`@anthropic-ai/claude-agent-sdk`), **`opencode`** (`@opencode-ai/sdk`), and
**`copilot`** (`@github/copilot-sdk`). Every adapter follows the same shape so
that the rest of the system outside this folder — `stream-manager`, MCP, DB,
WebSocket, frontend chat, settings UI — stays **agnostic** to the underlying
SDK.

This document covers **end to end**:

1. Full architecture map
2. The `backend/engine/` layer (adapter contract)
3. The `engine_providers` + `engine_accounts` DB tables
4. WebSocket routes — `engine:*`, `system-tools:*`, `chat:stream`, `models:list`
5. Frontend stores & components (Settings → Engines, Settings → System Tools)
6. Chat-input integration (model picker, stream)
7. Registering a binary in **Settings → System Tools**
8. **End-to-end checklist** for adding a new adapter
9. Lessons learned — pitfalls when authoring a new adapter

---

## 1. Architecture map

```
┌──────────────────── FRONTEND (Svelte 5 + runes) ─────────────────────┐
│                                                                       │
│  Settings → Engines           Settings → System Tools  Chat Input     │
│  ─────────────────────        ──────────────────────  ──────────────  │
│  AIEnginesSettings.svelte     SystemToolsSettings…    EngineModel…    │
│       │                            │                       │          │
│       ├─ claudeAccountsStore       └─ ws.http(             ├─ model   │
│       ├─ copilotAccountsStore         'system-tools:…')    │  Store   │
│       ├─ opencodeProvidersStore                            └─ chat    │
│       └─ modelStore                                          ModelState│
│       │            │             │             │             │        │
│       ▼            ▼             ▼             ▼             ▼        │
│  ws.http('engine:*')   ws.http('system-tools:*')   ws.emit('chat:…')  │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ WebSocket (ws-server router)
┌──────────────────────────────▼────────────────────────────────────────┐
│                          BACKEND ROUTERS                              │
│                                                                       │
│  backend/ws/engine/claude/      backend/ws/engine/opencode/           │
│    status.ts, accounts.ts         status.ts, providers.ts             │
│  backend/ws/engine/copilot/                                           │
│    status.ts, accounts.ts                                             │
│  backend/ws/system-tools/         backend/ws/chat/stream.ts           │
│    status.ts, install.ts          backend/ws/settings/crud.ts         │
│           │                                  │                        │
│           ▼                                  ▼                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  backend/engine/         ← THE LAYER THIS README DOCUMENTS       │ │
│  │  ──────────────────                                              │ │
│  │  index.ts                  registry: getEngine / getProjectEngine│ │
│  │  types.ts                  contract: AIEngine                    │ │
│  │  install-recipes.ts        per-platform install commands         │ │
│  │  install-runner.ts         spawns recipe, streams logs over WS   │ │
│  │  adapters/<name>/                                                │ │
│  │    index.ts                public surface (re-exports only)      │ │
│  │    stream.ts               class implements AIEngine             │ │
│  │    message-converter.ts    SDK message → EngineOutput            │ │
│  │    environment.ts          env setup (claude only)               │ │
│  │    server.ts               subprocess + client (opencode only)   │ │
│  │    config.ts               provider catalog (opencode only)      │ │
│  │    error-handler.ts        SDK error → user-facing string        │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│           │                                  │                        │
│           ▼                                  ▼                        │
│  backend/database/queries/        backend/chat/stream-manager.ts      │
│    engine-queries.ts                routes EngineOutput → DB + WS     │
│      engine_providers + engine_accounts                               │
└───────────────────────────────────────────────────────────────────────┘
```

Three key rules that **every** layer upholds:

- **`EngineOutput`** (in `shared/types/unified/stream.ts`) is the only data
  shape that crosses the adapter → stream-manager boundary. No other type
  may leak out of an adapter.
- **`engine_providers` + `engine_accounts`** are the only source of
  credentials. An adapter never reads arbitrary env vars; it reads from
  the DB via `engineQueries`.
- **`AIEngine`** (in `types.ts`) is the only class the stream-manager calls.
  New methods are not added ad-hoc — they are added to the interface first,
  then implemented in **every** adapter.

---

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

### 2.6 Standard files in each adapter

```
adapters/<name>/
├── index.ts                ← re-exports only, NO logic
├── stream.ts               ← class implements AIEngine
├── message-converter.ts    ← SDK message → EngineOutput (pure functions)
├── environment.ts?         ← env-var setup (Claude needs this)
├── server.ts?              ← spawn + manage subprocess (OpenCode needs this)
├── config.ts?              ← provider catalog / config builder (OpenCode needs this)
└── error-handler.ts?       ← SDK error → user-facing string (Claude & Copilot have one)
```

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

---

## 3. Database — `engine_providers` & `engine_accounts`

Migration: `backend/database/migrations/029_migrate_messages_to_unified.ts`
(Phases 6–7). Previously split into `claude_accounts`, `opencode_providers`,
`opencode_accounts` — now **consolidated**.

### 3.1 Schema

```sql
CREATE TABLE engine_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_type TEXT NOT NULL,            -- 'claude-code' | 'opencode' | 'copilot' | <new>
  slug        TEXT NOT NULL,            -- 'anthropic', 'openai', etc (lowercase)
  name        TEXT NOT NULL,            -- display name
  npm         TEXT,                     -- npm package (opencode), NULL for claude/copilot
  api_url     TEXT,                     -- custom endpoint
  options     TEXT NOT NULL DEFAULT '{}', -- JSON: env var values, flags
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (engine_type, slug)
);

CREATE TABLE engine_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES engine_providers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  credential  TEXT NOT NULL,            -- OAuth token / API key / PAT
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Concepts:
- **Provider** = "who owns the model". For `claude-code` there is exactly
  one provider (`anthropic`, seeded in the migration). For `copilot` there
  is exactly one provider (`github`, seeded in `032_seed_copilot_provider.ts`).
  For `opencode`, the user adds many providers (Anthropic, OpenAI, Google,
  OpenRouter, …).
- **Account** = the concrete credential under a provider. Multiple are
  allowed; exactly one row per provider has `is_active = 1`.
- **Switching account** flip-flags automatically:
  `engineQueries.switchAccount(id)` sets all accounts under that provider
  to `is_active = 0`, then sets the chosen one to `1`.
- **Deleting the active account** automatically promotes another account in
  the same provider to active (logic in `engineQueries.deleteAccount`).

### 3.2 Main helpers (`engineQueries`)

```ts
// Provider
getProviders(engineType?)            getEnabledProviders(engineType?)
getProvider(id)                      getProviderBySlug(engineType, slug)
createProvider({...})                updateProviderOptions(id, jsonStr)
toggleProvider(id, enabled)          deleteProvider(id)   // cascades to accounts

// Account
getAccount(id)                       getAccountsByProvider(providerId)
getActiveAccount(providerId)         getActiveAccountForEngine(engineType)
createAccount(providerId, name, credential)              // auto-active if first
switchAccount(accountId)             deleteAccount(accountId)
renameAccount(accountId, name)

// Composite
getProvidersWithAccounts(engineType?) // join used by endpoint listing
```

### 3.3 How an adapter reads them

- **Claude** — `environment.ts` calls
  `engineQueries.getActiveAccountForEngine('claude-code')` inside
  `setupEnvironmentOnce()` to inject `CLAUDE_CODE_OAUTH_TOKEN`. When
  `streamQuery` is called with an explicit `accountId`,
  `getEngineEnv(accountId)` overrides the token without mutating singleton
  state — ideal for per-stream account override.

- **OpenCode** — `config.ts::generateOpenCodeProviderConfig()`:
  1. `engineQueries.getEnabledProviders('opencode')`
  2. For each provider, `getActiveAccount(provider.id)`
  3. Look up the env-var name(s) from the `models.dev` catalog (see §3.4)
  4. Inject the first env var with `account.credential`, remaining env vars
     from `provider.options` JSON
  5. Result: `enabledProviders[]` (for `OPENCODE_CONFIG_CONTENT`) +
     `envVars{}` (merged into the `opencode serve` process)

- **Copilot** — `stream.ts::initialize(accountId?)` calls
  `engineQueries.getAccount(accountId)` (or
  `getActiveAccountForEngine('copilot')` when no override is supplied)
  and constructs a fresh `CopilotClient({ gitHubToken: account.credential })`.
  The Copilot SDK takes the token at **client construction time**, so a
  per-stream account switch requires `dispose()` + `initialize(newId)` —
  see `streamQuery` in `copilot/stream.ts` and §9.9 below.

### 3.4 The models.dev catalog (OpenCode-specific)

`config.ts` caches the catalog in the `settings` table under
`opencode.models_dev_cache` (+ `opencode.models_dev_cached_at`). The catalog
lists the providers OpenCode supports along with the env-var names they
expect. The frontend uses the catalog in the "Add Provider" picker — the
user just selects a provider, enters the API key, and the env-var mapping
is automatically correct.

---

## 4. WebSocket routes

All handlers use `createRouter()` (Elysia + ws-server). Routers are merged
in `backend/ws/index.ts`. Four groups are relevant for engines:

| Group                           | Path                                | Purpose                                    |
|---------------------------------|-------------------------------------|--------------------------------------------|
| `engine:claude-*`               | `backend/ws/engine/claude/`         | Status + Claude account CRUD               |
| `engine:opencode-*`             | `backend/ws/engine/opencode/`       | Status + provider/account CRUD + restart   |
| `engine:copilot-*`              | `backend/ws/engine/copilot/`        | Status + Copilot account CRUD              |
| `system-tools:*`                | `backend/ws/system-tools/`          | Detect/install binaries                    |
| `models:list`, `chat:stream`    | `backend/ws/settings/crud.ts`, `backend/ws/chat/stream.ts` | Model fetch + stream start |

### 4.1 Claude — `engine:claude-*`

`backend/ws/engine/claude/index.ts` merges two sub-handlers:

| Event                                       | Mode    | Purpose                                       |
|---------------------------------------------|---------|-----------------------------------------------|
| `engine:claude-status`                      | `.http` | `{ installed, version, activeAccount, accountsCount, backendOS }` |
| `engine:claude-accounts-list`               | `.http` | List Claude accounts                          |
| `engine:claude-accounts-switch`             | `.http` | Set active; calls `resetEnvironment()` so a new token is picked up on the next stream |
| `engine:claude-accounts-delete`             | `.http` |                                               |
| `engine:claude-accounts-rename`             | `.http` |                                               |
| `engine:claude-account-setup-start`         | `.on`   | Spawn PTY `claude setup-token` (state machine `waiting-url → waiting-token → done`) |
| `engine:claude-account-setup-submit`        | `.on`   | Send the auth code to the PTY                 |
| `engine:claude-account-setup-cancel`        | `.on`   |                                               |
| `engine:claude-account-setup-url` (emit)    |         | OAuth URL detected in PTY output              |
| `engine:claude-account-setup-complete` (emit) |       | Token success → `engineQueries.createAccount` + `resetEnvironment()` |
| `engine:claude-account-setup-error` (emit)  |         |                                               |
| `engine:claude-account-setup-pty-data` (emit) |       | Stream raw PTY (debug)                        |

The Claude setup flow needs a PTY because Anthropic's CLI is interactive.
See `backend/ws/engine/claude/accounts.ts` for the state-machine details
(one `onData` listener + one `onExit` per session, the phase tracked in a
`phase` field).

### 4.2 OpenCode — `engine:opencode-*`

`backend/ws/engine/opencode/index.ts` merges:

| Event                                       | Purpose                                       |
|---------------------------------------------|-----------------------------------------------|
| `engine:opencode-status`                    | `{ installed, version, backendOS }`           |
| `engine:opencode-providers-list`            | List `engine_providers WHERE engine_type='opencode'` + accounts |
| `engine:opencode-provider-add`              | Create provider + first account (auto-active) |
| `engine:opencode-provider-remove`           | Cascades to accounts                          |
| `engine:opencode-provider-toggle`           | Flip `is_enabled`                             |
| `engine:opencode-provider-update-options`   | Update JSON options (handler validates JSON)  |
| `engine:opencode-account-add`               | Add an account to a provider                  |
| `engine:opencode-account-switch`            |                                               |
| `engine:opencode-account-delete`            |                                               |
| `engine:opencode-account-rename`            |                                               |
| `engine:opencode-models-dev-list`           | Cached catalog (auto-fetches if absent)       |
| `engine:opencode-models-dev-fetch`          | Force refetch                                 |
| `engine:opencode-server-restart`            | Stop subprocess + clear stored URL → next stream spawns a fresh server |

`engine:opencode-server-restart` first checks whether any OpenCode stream
is active: if so and `force` was not set, it returns
`{ needsConfirmation: true, activeChats: N }` so the UI can ask for
confirmation. When `force=true`, all OpenCode streams are `cancelStream`'d,
followed by `disposeEngine('opencode')` + `disposeOpenCodeClient(true)` —
the `forRestart` flag drops the stored URL and kills the server even if
Clopen did not spawn it (the reuse case).

### 4.3 Copilot — `engine:copilot-*`

`backend/ws/engine/copilot/index.ts` merges:

| Event                                | Purpose                                       |
|--------------------------------------|-----------------------------------------------|
| `engine:copilot-status`              | `{ installed, version, activeAccount, accountsCount, backendOS }` |
| `engine:copilot-accounts-list`       | List Copilot accounts                         |
| `engine:copilot-accounts-add`        | Add account by submitting a GitHub PAT        |
| `engine:copilot-accounts-switch`     | Set active                                    |
| `engine:copilot-accounts-delete`     |                                               |
| `engine:copilot-accounts-rename`     |                                               |

The Copilot setup flow does not need a PTY — the user pastes a GitHub
Personal Access Token in the UI (Copilot Requests + read:user scope), and
the handler stores it via `engineQueries.createAccount`. No re-auth dance.

### 4.4 System Tools — `system-tools:*`

`backend/ws/system-tools/`:

| Event                              | Purpose                                     |
|------------------------------------|---------------------------------------------|
| `system-tools:status`              | Detect a single tool: `{ status, recipe, activeSession }` |
| `system-tools:status-all`          | Hardcoded list `['git','claude','opencode','chrome','cloudflared']` |
| `system-tools:install-start`       | Spawn the recipe via `install-runner`       |
| `system-tools:install-cancel`      |                                             |
| `system-tools:install-session`     | Snapshot session (for re-attach)            |
| `system-tools:install-started` (emit)  | Session begun                           |
| `system-tools:install-stream` (emit)   | Per-line stdout/stderr                  |
| `system-tools:install-finished` (emit) | exit code + final status                |

### 4.5 `models:list` (in `backend/ws/settings/crud.ts`)

```ts
.http('models:list', { data: { engine } }, async ({ data }) => {
  if (data.engine === 'claude-code') return CLAUDE_CODE_MODELS;
  const engine = await initializeEngine(data.engine);
  const models = await engine.getAvailableModels();
  registerModels(data.engine, models);
  return models;
})
```

Claude models are **static** in `shared/constants/engines.ts`. OpenCode
calls `client.config.providers()` against the running server and maps the
provider catalog to `EngineModel[]` (see `OpenCodeEngine.getAvailableModels`).
Copilot calls `client.listModels()` after `client.start()` and maps each
`ModelInfo` to `EngineModel` (see `CopilotEngine.getAvailableModels`).

### 4.6 `chat:stream` — the streaming entry point

`backend/ws/chat/stream.ts` accepts:

```ts
{
  sessionId: string,
  chatSessionId: string,
  projectPath: string,
  prompt: UserMessage,
  engine: { type, provider, model: { id, name }, account: { id, name } },
  sender: { id, name }
}
```

The handler calls `streamManager.startStream(...)`, which then:
1. Resolves `getProjectEngine(projectId, engine.type)`
2. Calls `engine.streamQuery({ projectPath, prompt, providerSlug, modelId, accountId, mcpContext, ... })`
3. Iterates over `EngineOutput` and emits each one to the chat session room
   via `ws.emit.chatSession(...)`.

---

## 5. Frontend — Settings UI

### 5.1 Settings → Engines

Files:
- `frontend/components/settings/engines/AIEnginesSettings.svelte`
- Stores: `frontend/stores/features/claude-accounts.svelte.ts`,
  `frontend/stores/features/copilot-accounts.svelte.ts`,
  `frontend/stores/features/opencode-providers.svelte.ts`

Pattern:
- The component renders one card **per engine** from the `ENGINES` constant
  in `shared/constants/engines.ts` (icon, name, description).
- For **Claude**: calls `engine:claude-status`. The "Add Account" button
  starts `engine:claude-account-setup-start` and renders an xterm terminal
  for debug + to display the auth URL.
- For **Copilot**: calls `engine:copilot-status` and
  `copilotAccountsStore.fetch()`. "Add Account" submits a GitHub PAT
  directly via `engine:copilot-accounts-add` (no PTY required).
- For **OpenCode**: calls `engine:opencode-status` and
  `opencodeProvidersStore.fetchProviders()`. "Add Provider" picks from the
  `models.dev` catalog, fills in API key + extra env options (per
  `catalogEntry.env[]`), and submits → `engine:opencode-provider-add`.
- After an account switch / restart: refresh the relevant store
  (`claudeAccountsStore.refresh()` / `copilotAccountsStore.refresh()` /
  `opencodeProvidersStore.refreshProviders()`) and call
  `modelStore.refreshModels()` to stay in sync.

**Stores**:
```ts
claudeAccountsStore        // accounts[], fetch(), refresh(), set(), reset()
copilotAccountsStore       // accounts[], fetch(), refresh(), set(), reset()
                           // (identical API to claudeAccountsStore)
opencodeProvidersStore     // providers[], catalog[], catalogCachedAt,
                           // fetchProviders/refreshProviders, addProvider,
                           // removeProvider, toggleProvider,
                           // updateProviderOptions,
                           // addAccount, switchAccount, deleteAccount,
                           // renameAccount,
                           // fetchCatalog, refreshCatalog, refetchCatalog,
                           // restartServer, reset
modelStore                 // models[], fetchModels(engine), refreshModels(engine),
                           // getByEngine(engine), getById(modelId)
```

### 5.2 Settings → System Tools

Files:
- `frontend/components/settings/system-tools/SystemToolsSettings.svelte`
- `frontend/components/settings/system-tools/ToolInstallCard.svelte`

`SystemToolsSettings` renders one `ToolInstallCard` per tool (`git`,
`claude`, `opencode`, `chrome`, `cloudflared`). `ToolInstallCard`:

1. Calls `system-tools:status` on mount.
2. Renders: status (installed/version/source), an "Install" button if
   `recipe.autoInstallable`, otherwise a "Manual install" dialog.
3. While installing: `system-tools:install-start` → subscribe to
   `system-tools:install-stream` (per-line) → render in xterm + show
   exit status from `system-tools:install-finished`.
4. The session survives navigation: if `activeSession` exists on refresh,
   re-attach to the same session id.

To add a new tool (e.g. `goose`):
1. Add the literal to `ToolId` (`backend/engine/install-recipes.ts`).
2. Add `resolveGooseRecipe()` + a case in `resolveRecipe()`.
3. Add the literal to `TOOL_UNION` (`backend/ws/system-tools/status.ts`
   and `install.ts`).
4. Add `<ToolInstallCard tool="goose" title="Goose" description="…" />`
   in `SystemToolsSettings.svelte`.
5. (Optional) expose detection in the `engine:<name>-status` handler so
   Settings → Engines can show an "Installed" badge.

---

## 6. Chat integration — model picker & stream

### 6.1 chat-input state

`frontend/stores/ui/chat-model.svelte.ts` — `chatModelState`:

```ts
{ engine, provider, modelId, modelName,
  engineModelMemory: { [engine]: { provider, id, name } },
  accountId, accountName }
```

This store is **local to the active session**: settings under Settings →
Engines only seed the initial defaults via `initChatModel(...)`. Switching
engine/model in chat input does **not** affect Settings.

### 6.2 EngineModelPicker (in chat input)

`frontend/components/chat/input/components/EngineModelPicker.svelte`:
- Engine tabs from `ENGINES`.
- Model list from `modelStore.getByEngine(engine)` — auto-fetched via
  `modelStore.fetchModels(engine)` whenever the engine changes.
- **Account picker for `claude-code` and `copilot`** (single-account-list
  engines): both stores expose the same
  `{ accounts, fetch, refresh, set, reset }` API, so a single dropdown
  drives both. The component derives `accountsForEngine` from
  `chatModelState.engine`, the chosen account is written into
  `chatModelState.accountId` / `accountName`, and on send it is forwarded
  as `engine.account.id` to the backend (see §6.3). To add a third engine
  with this same shape, add a branch in `accountsForEngine`,
  `accountPickerLabel`, `showAccountPicker`, and the auto-select `$effect`
  — no new dropdown markup is needed.
- **OpenCode** has a separate picker because its accounts are scoped to a
  provider, which is implied by the currently selected model. The picker
  resolves the model's provider via `ocMatchingProvider`, then writes the
  chosen account into `chatModelState.accountId` and triggers a server
  restart.

### 6.3 Send path → backend

`frontend/services/chat/chat.service.ts` on submit:

```ts
ws.emit('chat:stream', {
  sessionId: <ephemeral>,
  chatSessionId: ...,
  projectPath: ...,
  prompt: <UserMessage>,
  engine: {
    type:    chatModelState.engine,
    provider: chatModelState.provider,
    model:   { id: chatModelState.modelId, name: chatModelState.modelName },
    account: { id: chatModelState.accountId ?? 0, name: chatModelState.accountName ?? '' },
  },
  sender: { id, name }
});
```

Backend `chat:stream` then `streamManager.startStream(...)`, which:
- Resolves `getProjectEngine(projectId, engine.type)`
- Calls `engine.streamQuery({ projectPath, prompt, providerSlug: engine.provider, modelId: engine.model.id, accountId: engine.account.id !== 0 ? engine.account.id : undefined, mcpContext })`
- Yields `EngineOutput` → emits `chat:message` / `chat:partial` /
  `chat:notification` to the session room.

> **`accountId !== 0`** is the convention for "use override". `0` means
> "fall back to the active account in DB". Account-aware adapters
> (`claude`, `copilot`) read this and override their per-stream credential
> accordingly.

### 6.4 Reasoning, attachments, AskUserQuestion

- **Reasoning**: an adapter must emit
  `StreamLifecycleEvent { reasoning: true }` to mark start/stop of the
  thinking block, then `TextDeltaEvent { reasoning: true }` for each delta.
  The frontend renders these in a separate bubble.
- **Attachments**: `UserMessage.content` carries `text | image | document`
  blocks. The adapter maps these to the SDK's format — Claude uses native
  content blocks, OpenCode uses `extractPromptParts()` to
  `data:<mime>;base64,...`.
- **AskUserQuestion**: a standard tool that the adapter must intercept.
  See `claude/stream.ts::canUseTool` (in-process) and
  `opencode/stream.ts::question.asked` (event-driven + HTTP fallback).
  The answer arrives via `engine.resolveUserAnswer(toolUseId, answers)`
  from the chat router.

---

## 7. Registering a binary in System Tools (`install-recipes.ts`)

`install-recipes.ts` is a **declarative** registry of install commands.
`install-runner.ts` is what actually runs them.

### 7.1 Anatomy of a `Recipe`

```ts
interface Recipe {
  tool: ToolId;
  autoInstallable: boolean;
  unavailableReason?: string;       // shown when not auto-installable
  command?: string[];               // argv for Bun.spawn
  shell?: { program; args };        // wrap argv (sh -c, pwsh -Command)
  requiresCurl?: boolean;           // staged static-curl if needed
  pendingCurlDownload?: { version, url, sha256, archKey };
  displayCommand?: string;          // string for the confirm dialog
  env?: Record<string, string>;     // extra env for the subprocess
  missingPrereqs: ToolId[];
  manualInstructions: ManualInstruction[]; // always present (copy-able fallback)
}
```

### 7.2 Per-platform pattern

`resolveRecipe(tool)` switches to a per-tool resolver. Each resolver:
1. Builds `base: Recipe` with full `manualInstructions` (always provide a
   fallback for users on unsupported OSes).
2. Checks platform (`process.platform`) and package manager:
   - macOS: `brew`
   - Linux: `apt | dnf | pacman | apk | zypper` (`detectLinuxPkgMgr`)
   - Windows: `winget | scoop | choco` (`detectWindowsPkgMgr`)
3. Checks privilege via `isElevated()` if the package manager needs
   root/admin.
4. If the installer uses `curl`, calls `attachCurlRequirement(base, label)`
   so the runner can stage SHA-pinned static-curl from
   `static-curl-assets.ts` when the system has no curl.
5. Sets `autoInstallable = true` + `command` + `shell` + `displayCommand`,
   or leaves it `false` with `unavailableReason` so the UI renders manual
   instructions only.

### 7.3 Status detection

`getToolStatus(tool)` returns `{ tool, installed, version, source }`:
- `chrome` has a special path (puppeteer cache scan + system Chrome).
- `cloudflared` at `~/.clopen/bin/cloudflared` is marked `source: 'clopen'`.
- Otherwise `resolveBinaryWithRefresh(tool)` + `runVersion(resolved)`.

### 7.4 Runner

`install-runner.ts::startInstall(tool, userId)`:
1. Verifies no other session is active for this tool
   (`InstallAlreadyRunningError`).
2. Resolves the recipe, validates `autoInstallable && command`
   (`InstallNotAutoInstallableError`).
3. If `requiresCurl`, calls `ensureCurlAvailable(...)` (downloads
   pinned static-curl if needed, prepends its dir to PATH).
4. `Bun.spawn(spawnArgs, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env })`.
5. Streams stdout/stderr per-line into a ring buffer (10k lines) + emits
   `system-tools:install-stream` to the user room.
6. On exit: emits `system-tools:install-finished` + retains the session
   for 5 minutes for re-attach.

Exit-code hints (`explainFailure(137|143, cancelled)`) explain SIGKILL OOM
or SIGTERM with actual total/free memory readings.

### 7.5 Adding a new tool

1. Add the literal to `ToolId` (`'goose'`).
2. Write `resolveGooseRecipe(): Promise<Recipe>` following the
   `resolveOpenCodeRecipe` pattern.
3. Add a case in `resolveRecipe(tool)`.
4. Add the literal to `TOOL_UNION` (`status.ts`, `install.ts`).
5. Add `<ToolInstallCard tool="goose" ... />` in
   `SystemToolsSettings.svelte`.
6. (Optional) detect in `engine:<engine>-status` so Settings → Engines
   knows the binary is installed.

---

## 8. End-to-end checklist for adding a new engine

The steps below are the same pattern used when the **`copilot`**
(`@github/copilot-sdk`) adapter was added to the repo. Use it as a
blueprint for the next engine you add.

### Stage 1 — Shared types

- [ ] `shared/types/unified/common.ts`: add `'newengine'` to `EngineType`.
- [ ] `shared/types/unified/engine.ts`: add `'newengine'` to `EngineInfo.type`.
- [ ] `shared/types/unified/message.ts`: add `'newengine'` to `MessageEngine.type`.
- [ ] `shared/constants/engines.ts`: add an entry in `ENGINES[]`
      (`type, name, description, icon.light, icon.dark`).
- [ ] (Optional) `NEWENGINE_MODELS` if the model list is static. If it's
      dynamic via the SDK, leave it empty.

### Stage 2 — Adapter `backend/engine/`

- [ ] Create `backend/engine/adapters/newengine/`
- [ ] `index.ts` → `export { NewEngineEngine } from './stream';`
      (+ `disposeXxxClient` if there is a subprocess).
- [ ] `stream.ts` → class `NewEngineEngine implements AIEngine`. Pick a
      template: `claude/stream.ts` (in-process SDK), `opencode/stream.ts`
      (subprocess), or `copilot/stream.ts` (in-process SDK with
      construction-time credential).
- [ ] `message-converter.ts` → pure functions SDK → `EngineOutput`.
      Use `toCanonicalToolName()` for tool names.
- [ ] `environment.ts` / `server.ts` / `config.ts` / `error-handler.ts`
      as the SDK requires.
- [ ] `backend/engine/index.ts`: import + add a case in
      `createEngine(type)`. If there is a shared subprocess, call
      `disposeXxxClient()` from `disposeAllProjectEngines()`.

### Stage 3 — Database (if a default provider needs to be seeded)

- [ ] Add a new migration in `backend/database/migrations/` (e.g. seed
      `('newengine', 'vendor', 'Vendor', NULL, NULL, '{}', 1)` into
      `engine_providers`). **Do not change the schema** — the tables
      are already generic.

### Stage 4 — WebSocket `engine:newengine-*`

- [ ] Create `backend/ws/engine/newengine/`:
  - `status.ts` — `engine:newengine-status` (`installed`, `version`, etc).
  - `accounts.ts` or `providers.ts` — account/provider CRUD:
    - List, add, switch, delete, rename.
    - Setup flow: PTY (Claude-style) OR direct API-key/PAT input
      (OpenCode/Copilot-style) depending on the SDK's auth mechanism.
  - `index.ts` — merge the sub-router.
- [ ] `backend/ws/engine/index.ts`: `.merge(newengineEngineRouter)`.
- [ ] `backend/ws/chat/stream.ts`: add the `'newengine'` literal to the
      typebox schema for `engine.type`.
- [ ] `backend/ws/settings/crud.ts`: add the `'newengine'` literal to the
      `models:list` typebox schema.

### Stage 5 — Frontend store

- [ ] Add `frontend/stores/features/newengine-accounts.svelte.ts` (or
      `newengine-providers.svelte.ts` following OpenCode's style if the
      engine is multi-provider). Mirror the pattern of
      `claudeAccountsStore` / `copilotAccountsStore` / `opencodeProvidersStore`.

### Stage 6 — Settings → Engines

- [ ] Add a panel to `AIEnginesSettings.svelte`: the card appears
      automatically since `ENGINES` already has the new entry. Implement
      the setup flow:
  - Load status via `ws.http('engine:newengine-status', {})`.
  - Subscribe to server-emit events for login progress.
  - After save: `newengineStore.refresh()` +
    `modelStore.refreshModels('newengine')`.

### Stage 7 — Settings → System Tools

- [ ] `backend/engine/install-recipes.ts`:
  - Add `'newengine'` to `ToolId`.
  - Write `resolveNewEngineRecipe()` (winget/brew/curl pipe — whatever the
    SDK needs to install its CLI).
  - Add a case in `resolveRecipe()`.
- [ ] `backend/ws/system-tools/status.ts` & `install.ts`: add
      `'newengine'` to `TOOL_UNION`.
- [ ] `frontend/components/settings/system-tools/SystemToolsSettings.svelte`:
      `<ToolInstallCard tool="newengine" title="NewEngine CLI" description="..." />`.

### Stage 8 — Chat input

If the engine uses one-account-per-engine (Claude/Copilot style), wire it
into `EngineModelPicker.svelte`:

- [ ] Import the new store + add a branch to `accountsForEngine`,
      `accountPickerLabel`, `showAccountPicker`, and the two
      `$effect` blocks (auto-fetch and auto-select active account).
- [ ] No new dropdown markup is required — the existing dropdown iterates
      `accountsForEngine`.

If the engine is multi-provider (OpenCode style) the picker logic is
heavier — copy the OpenCode block.

Other auto wiring:
- [ ] The engine tab appears automatically in `EngineModelPicker` from
      `ENGINES`.
- [ ] Verify: select engine → model list appears → send message → stream
      runs.

### Stage 9 — Manual QA

From the project root:

```sh
bun run check && bun run lint
```

Then the minimum UI scenarios that must pass:

- [ ] Settings → System Tools → Install NewEngine CLI → exit 0.
- [ ] Settings → Engines → NewEngine → Add Account → status `Installed,
      Active account: <name>`.
- [ ] Chat input → pick NewEngine + model → send a message → assistant
      replies → cancel mid-stream → idle → send again → resume works.
- [ ] AskUserQuestion (if the SDK supports it) → appears in UI → submit
      answer → stream continues.
- [ ] Restart Clopen → state survives (account, provider, last-used model
      in chat).

---

## 9. Lessons learned — pitfalls when authoring a new adapter

These notes come from building the `copilot` adapter. Each item has been
gotten wrong at least once — keep this mental checklist in your head when
writing the next adapter.

### 9.1 Both tool name **and** tool input must be canonicalised

`toCanonicalToolName()` only guarantees the tool name does not become
`Unknown:*`. That is **not enough**: tool UI components (`Bash`, `Read`,
`Edit`, …) read specific fields (`command`, `filePath`, `oldString`, …).
Other SDKs use `snake_case` (`file_path`, `old_str`) or even bundle
multiple subcommands under a single name (e.g. Copilot's
`str_replace_editor` → split into `view`/`create`/`str_replace`/`edit`/`insert`).

The pattern used in `copilot/message-converter.ts`:

```ts
// 1. Map raw name → canonical UI name (snake → PascalCase + dispatch subcommand).
const COPILOT_TOOL_NAME_MAP: Record<string, string> = { 'bash': 'Bash', ... };
function mapCopilotToolName(rawName, mcpServerName) { ... }

// 2. Per-tool normaliser: takes Record<string, unknown>, returns canonical shape.
function normalizeReadInput(raw): ReadInput {
  // path → filePath, view_range:[s,e] → offset/limit, etc.
}

// 3. Dispatcher called from buildToolUseBlock.
function normalizeCopilotToolInput(canonical, raw) {
  switch (canonical) { case 'Read': return normalizeReadInput(raw); ... }
}
```

If only the name mapping is done, the UI still picks the right component
but the fields are `undefined` → the user sees an empty block. Always
install **both** layers.

### 9.2 Filter the SDK's "harness tools"

Some SDKs emit internal tools used for model↔harness coordination that
**must not** appear in chat (intent reporting, task-completion markers,
internal documentation). Examples from Copilot CLI: `report_intent`,
`task_complete`, `propose_work`, `fetch_copilot_cli_documentation`.

Strategy: filter at the adapter boundary, do not render `Unknown:*`. See
`copilot/message-converter.ts::IGNORED_COPILOT_TOOLS` +
`isIgnoredCopilotTool()`. Drop **both sides**: the tool_use (in
`convertAssistantMessage`) **and** the tool_result that arrives later (in
`convertToolComplete`) — if you only drop one side, the UI either gets an
orphan result without a tool or an orphan tool without a result.

### 9.3 One `tool_use` per `AssistantMessage`

The convention used by Claude and OpenCode: each assistant message that
reaches the frontend has **at most one** `tool_use` block. SDKs like
Copilot CLI may send a single `assistant.message` with many `toolRequests`
— the adapter must split it.

Pattern:
```ts
const blocks: AssistantContentBlock[] = [];
if (data.content) blocks.push({ type: 'text', text: data.content });
for (const req of visibleToolRequests) blocks.push(buildToolUseBlock(req));

const messages = blocks.map((block, idx) => ({
  type: 'assistant',
  messageId: blocks.length === 1 ? baseId : `${baseId}:${idx}`,
  content: [block],   // one block per message
  ...
}));
```

If violated, the frontend `message-grouper` still works but Compact mode
and the tool layout do not stitch correctly.

### 9.4 Buffer messages until the usage event arrives

In many SDKs (Copilot included), `assistant.usage` is a **separate** event
that arrives **after** `assistant.message` for the same turn iteration.
If the adapter yields the message immediately, the `usage` field is
always `null` in the DB and in the token-cost dashboard.

Buffering pattern in `copilot/message-converter.ts`:

```ts
// State:
pendingMessages: UnifiedAssistantMessage[];
lastUsage: AssistantUsageData | null;

// convertAssistantMessage: push to pending, return what was already flushed.
state.pendingMessages.push(...messages);
return flushPending(state);   // flush old queue, leave the new ones waiting

// captureUsage: attach to the last pending, then flush.
state.pendingMessages.at(-1)!.usage = mapUsage(data);
return flushPending(state);

// flushPending also has a fallback: if a pending message still has
// usage == null but state.lastUsage is set, fill it in. This covers
// turns where the SDK emits assistant.message after assistant.usage,
// or tool-only iterations whose usage event landed earlier.
//
// Defensive flush at tool.execution_complete, turn_end, session.idle —
// preserve ordering even when the SDK sends events out of order.
```

The `lastUsage` state is also kept around to build the aggregate
`ResultEvent` at `session.idle` — that is the **per-stream** usage, not
per-message.

### 9.5 `tool_use.result: null` is **expected** before render

When inspecting raw adapter output (e.g. logs or DB rows before render),
`tool_use` blocks always carry `result: null`. That is **correct**: the
tool_result arrives as a synthetic `UserMessage` with `toolUseId`. The
frontend `message-grouper.ts` (via `processToolMessage` + `toolUseMap`)
attaches it at display time.

Do not try to perform that stitching in the adapter — if you do, the
`stream-manager` loses the chance to persist the tool_result as its own
DB row, and resume-session breaks.

**Sharp edge — `parent.toolUseId` MUST be null on the synthetic
UserMessage.** The toolCallId belongs only on the inner `tool_result`
block, never on the message-level `parent.toolUseId`. The frontend
grouper interprets any user message with `parent.toolUseId !== null` as
a **sub-agent message** (i.e. one emitted from inside an `Agent` /
`Task` tool execution): if the parent id matches an Agent tool it goes
into the sub-agent activity bucket, otherwise it is silently dropped.
Setting `parent.toolUseId = data.toolCallId` therefore makes the
tool_result invisible to the UI and `tool_use.result` stays null after
render.

```ts
// ✅ correct — top-level tool_result (Claude, OpenCode, Copilot)
parent: { messageId: null, sessionId: null, toolUseId: null }

// ❌ wrong — frontend grouper drops this as a "sub-agent" message
parent: { messageId: null, sessionId: null, toolUseId: data.toolCallId }
```

Only set `parent.toolUseId` when the message is genuinely a child of an
`Agent` / `Task` tool execution (e.g. the OpenCode Task adapter passes
`parentToolUseId` through `convertToolResultOnly`). For raw
`tool.execution_complete` events at the top of the loop, leave it null.

### 9.6 Enable the SDK's streaming flag explicitly

Some SDKs default to emitting only the final message. For delta/partial
streaming you must set the SDK-specific flag:

- Copilot: `streaming: true` in `SessionConfig` & `ResumeSessionConfig`.
- OpenCode: `partial: true` in chat options.
- Claude: `includePartialMessages: true` (already on by default in
  `ClaudeCodeEngine.streamQuery`).

Without the flag, the UI shows text "all at once" — the symptom is
identical to an adapter that forgot to emit `StreamLifecycleEvent` /
`TextDeltaEvent`, so check the flag first before debugging the converter.

### 9.7 Pair `start`/`stop` lifecycle for reasoning

The frontend stream-manager renders reasoning in a separate bubble
**only** while `StreamLifecycleEvent { reasoning: true, event: 'start' }`
is open. Always emit `stop` when reasoning ends (or when assistant text
begins — the two are mutually exclusive in the UI). See
`copilot/message-converter.ts::convertReasoningDelta`, which flushes the
text stream before opening the reasoning stream.

### 9.8 Event-order debug workflow

If chat output looks weird, log the raw `SessionEvent` per stream before
the converter. The canonical Copilot order is:

```
session.start
assistant.turn_start
[assistant.reasoning_delta...]    assistant.reasoning
[assistant.message_delta...]      assistant.message     assistant.usage
                                                        tool.execution_start
                                                        tool.execution_complete
[loop back to reasoning/message for the next turn iteration]
assistant.turn_end
session.idle
```

From here it is easy to trace: if `usage` is always null, buffering is
wrong. If you see orphan tool_results, the ignored-tools filter is not
consistent on both sides. If text appears all at once, the SDK streaming
flag is off.

### 9.9 Per-stream account override when the SDK takes the credential at construction

Most SDKs accept env vars per-call (Claude) or read them from the
subprocess environment (OpenCode). The Copilot SDK is different: the
GitHub token is passed to `new CopilotClient({ gitHubToken })` at
construction time and cannot be swapped on the fly.

Pattern in `copilot/stream.ts`:

```ts
private currentAccountId: number | null = null;

async initialize(accountId?: number): Promise<void> {
  if (this._isInitialized && (accountId == null || accountId === this.currentAccountId)) {
    return;   // already initialised with this account → no-op
  }
  const account = accountId != null
    ? engineQueries.getAccount(accountId)
    : engineQueries.getActiveAccountForEngine('copilot');
  this.client = new CopilotClient({ gitHubToken: account.credential, ... });
  this.currentAccountId = account.id;
  ...
}

async *streamQuery(options) {
  // Per-stream account override: dispose + re-init when it differs.
  if (this._isInitialized && options.accountId != null
      && options.accountId !== this.currentAccountId) {
    await this.dispose();
  }
  if (!this._isInitialized) await this.initialize(options.accountId);
  ...
}
```

The frontend wiring is shared with Claude (single-account-list engines —
see §6.2): both stores expose the same API, so `EngineModelPicker.svelte`
uses one derived `accountsForEngine` and one dropdown. To add a fourth
adapter that follows this same pattern, just add a branch in the four
derived values and the `$effect` blocks; do not duplicate the dropdown.

If you forget the per-stream override path, the chat input appears to
honour the account picker but the engine actually streams against the
last initialised credential — silently using the wrong PAT/quota.

### 9.10 Fork session — native API vs. on-disk workaround

The multi-branch checkpoints feature requires that **every** resume
spawn a fresh session id, so the engine continues from that point
**without** mutating the original session's history. Each adapter wires
it differently, but the contract is the same: fork unconditionally on
resume.

| Adapter   | How                                                                                |
|-----------|------------------------------------------------------------------------------------|
| Claude    | Pass `forkSession: true` in the SDK options on every call — native.               |
| OpenCode  | Call `client.session.fork({ path: { id: resume } })` on every resume — native.    |
| Copilot   | **No native API yet** — fork by copying the on-disk session state on every resume.|

> **Sharp edge — fork is NOT gated on `EngineQueryOptions.forkSession`.**
> The `forkSession` field exists on the type but the stream-manager
> never sets it; Claude/OpenCode hard-code their fork call. The Copilot
> adapter must do the same. If you only fork "when forkSession is true"
> the same Copilot session id is reused across every turn (visible in
> persisted assistant messages) and downstream branch logic breaks.

The Copilot CLI / SDK does not currently expose a fork primitive
(tracking issues: github/copilot-cli#1313, #1697, #2058). The
SDK's own recommended workaround — also what we implement in
`copilot/session-fork.ts` — is to copy the on-disk session state
directory and patch the embedded session identifiers:

```
~/.copilot/session-state/<sessionId>/
├── workspace.yaml      ← first line: `id: <sessionId>`     ← rewrite
├── events.jsonl        ← first event session.start.data.sessionId ← rewrite
├── checkpoints/
├── files/
└── research/
```

Both `workspace.yaml#id` and the first `events.jsonl` line's
`data.sessionId` must be replaced with the new fork id. After that,
`client.resumeSession(forkId, ...)` picks the directory up as a fresh
independent session.

```ts
// copilot/stream.ts (resume path) — fork on EVERY resume
let resumeId = resume;
if (sessionStateExists(resume)) {
  const forkId = crypto.randomUUID();
  if (forkCopilotSessionState(resume, forkId)) {
    resumeId = forkId;
  }
}
session = await this.client.resumeSession(resumeId, baseConfig);
```

The expected effect (compare against `log-2.txt`):

```
turn 1   user → assistant   sessionId: A
turn 2   user → assistant   sessionId: B   (forked from A)
turn 3   user → assistant   sessionId: C   (forked from B)
```

Every assistant message carries its **own** session id. Reusing the
same id across turns is the symptom that forking is gated or skipped.

When the SDK eventually adds a native `forkSession` (or
`client.session.fork()`), the migration is a one-liner: delete
`session-fork.ts`, drop the `forkCopilotSessionState` block, and pass
the SDK flag the same way Claude and OpenCode already do. The `// TODO`
comment in `copilot/stream.ts` pins the migration target.

### 9.11 Reset `currentAccountId` in `dispose()`

Whenever you track per-init state on the engine (e.g.
`currentAccountId`, cached models, the SDK client itself), reset every
field in `dispose()`. A half-disposed engine that still reports
`isInitialized = false` but holds a stale `currentAccountId` will short-
circuit the next `initialize(accountId)` call and reuse the wrong
credential.

```ts
async dispose(): Promise<void> {
  await this.cancel();
  if (this.client) await this.client.stop();
  this.client = null;
  this.modelsCache = null;
  this.currentAccountId = null;     // ← do not forget
  this._isInitialized = false;
}
```

---

## 10. Quick reference table

| Need                                        | File                                                      |
|---------------------------------------------|-----------------------------------------------------------|
| Lazy + concurrency-safe init                | `claude/environment.ts::setupEnvironmentOnce`, `opencode/server.ts::ensureClient` |
| Per-account credential override (env-var SDK) | `claude/environment.ts::getEngineEnv(accountId)`        |
| Per-account credential override (constructor SDK) | `copilot/stream.ts::initialize(accountId)` + dispose+reinit in `streamQuery` |
| Subprocess spawn + health + recovery        | `opencode/server.ts`                                      |
| Stateful per-stream converter               | `claude/message-converter.ts::createSdkMessageConverter`  |
| Split one SDK message → N `EngineOutput`    | `opencode/message-converter.ts::convertAssistantMessages`, `copilot/message-converter.ts::convertAssistantMessage` |
| Buffer until usage event arrives            | `copilot/message-converter.ts::flushPending` + `captureUsage` |
| Reasoning stream lifecycle                  | `opencode/stream.ts::flushReasoning`, `copilot/message-converter.ts::convertReasoningDelta` |
| Cancel-before-RPC ordering                  | `opencode/stream.ts::cancel`, `claude/stream.ts::cancel`, `copilot/stream.ts::cancel`  |
| Fork session (native vs. on-disk workaround) | `claude/stream.ts` (`forkSession: true`), `opencode/stream.ts` (`client.session.fork`), `copilot/session-fork.ts` (copy disk state) |
| AskUserQuestion event + HTTP fallback       | `opencode/stream.ts::resolveUserAnswer`, `claude/stream.ts::canUseTool` |
| `generateStructured` (no tools, JSON)       | `claude/stream.ts::generateStructured`, `opencode/stream.ts::generateStructured` |
| Error normalisation                         | `claude/error-handler.ts`, `copilot/error-handler.ts`, `opencode/stream.ts` `session.error` handler |
| DB provider/account access                  | `backend/database/queries/engine-queries.ts`              |
| Per-platform install recipe                 | `backend/engine/install-recipes.ts`                       |
| Streaming install logs                      | `backend/engine/install-runner.ts`                        |
| Frontend account/provider stores            | `frontend/stores/features/{claude-accounts,copilot-accounts,opencode-providers}.svelte.ts` |
| Frontend chat-model state                   | `frontend/stores/ui/chat-model.svelte.ts`                 |
| Settings UI (Engines)                       | `frontend/components/settings/engines/AIEnginesSettings.svelte` |
| Settings UI (System Tools)                  | `frontend/components/settings/system-tools/{SystemToolsSettings,ToolInstallCard}.svelte` |
| Chat picker (engine + model + account)      | `frontend/components/chat/input/components/EngineModelPicker.svelte` |
| Chat send → backend                         | `frontend/services/chat/chat.service.ts` (`ws.emit('chat:stream', …)`), `backend/ws/chat/stream.ts` |
| Stream-manager (`EngineOutput` routing)     | `backend/chat/stream-manager.ts`                          |

When in doubt: **mirror** the existing adapters and let `EngineOutput`
remain the only contract that crosses the adapter boundary.
