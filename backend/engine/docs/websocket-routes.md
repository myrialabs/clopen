[← Engine adapter guide](../README.md)

## 4. WebSocket routes

All handlers use `createRouter()` (Elysia + ws-server). Routers are merged
in `backend/ws/index.ts`. Four groups are relevant for engines:

| Group                           | Path                                | Purpose                                    |
|---------------------------------|-------------------------------------|--------------------------------------------|
| `engine:claude-*`               | `backend/ws/engine/claude/`         | Status + Claude account CRUD               |
| `engine:opencode-*`             | `backend/ws/engine/opencode/`       | Status + provider/account CRUD + restart   |
| `engine:copilot-*`              | `backend/ws/engine/copilot/`        | Status + Copilot account CRUD              |
| `stack:*`                       | `backend/ws/stack/`                 | Detect/install binaries                    |
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

#### Restart-Server pattern (long-lived server engines)

Engines that hold a **long-lived process or client** (OpenCode's `opencode
serve` subprocess, Copilot's `CopilotClient`) cache provider/account
credentials at boot or construction time. Adding, removing, or switching
an account does **not** automatically take effect for in-flight streams or
the cached client — the engine must be **restarted**. The adapter exposes
a `*-server-restart` event; the UI surfaces this to the user as a
**"Restart Server"** button in two places:

1. **Settings → Engines** card — shown whenever the user has just changed
   provider/account state (add / remove / switch). See
   `engines/panels/OpenCodePanel.svelte::handleRestartServer` (with the
   `needsConfirmation` confirm-dialog flow) and
   `forceRestartServer`.
2. **Chat Input → next to the model/account picker** — shown when the
   active session's account has just been switched mid-flight and the
   user needs to apply it before sending the next prompt. See
   `EngineModelPicker.svelte::ocNeedsRestart` / `restartOCServer`. The
   button uses `force: true` so users in chat don't see another modal.

The handler contract any restart event must follow:

| Step | Behavior |
|---|---|
| 1 | Inspect the engine's active streams. If any exist and `force !== true`, return `{ needsConfirmation: true, activeChats: N }` — UI then opens a confirm dialog. |
| 2 | When `force === true`, call `cancelStream` on every active stream for that engine. |
| 3 | Call `disposeEngine(engineType)` (clears the per-project map) and any adapter-specific shared-resource cleanup (`disposeOpenCodeClient(true)`, etc.). The flag tells the cleanup routine that this is a restart, not a shutdown — drop cached URLs / sockets even if reused from outside. |
| 4 | Resolve. The next `streamQuery` call will lazy-init the engine fresh against the new account state. |

After a successful restart the UI also refreshes models
(`modelStore.refreshModels(engineType)`) because the model catalog can
change with the credential.

**When a new engine does NOT need this:** if the engine spawns a
**fresh subprocess per turn** (Codex's `codex exec`, Claude's per-turn
`query()`), the credential is re-read at every turn and there is nothing
to "restart". Such engines do not implement `*-server-restart`. The
appropriate analog for shared-CLI-dotfile engines like Codex is the
auth-blob swap (§10.13) — performed inside `accounts-switch`, not via a
separate restart event.

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
| `engine:copilot-server-restart`      | Restart cached `CopilotClient` so a new PAT applies — same Restart-Server pattern as §4.2 |

The Copilot setup flow does not need a PTY — the user pastes a GitHub
Personal Access Token in the UI (Copilot Requests + read:user scope), and
the handler stores it via `engineQueries.createAccount`. No re-auth dance.

Copilot follows the **same Restart-Server pattern** documented in §4.2
because `CopilotClient` takes the PAT at construction time. Account
add / remove / switch flips a `needsRestart` flag in the UI that surfaces
a "Restart Server" button in both Settings → Engines and Chat Input.

### 4.4 Stack — `stack:*`

Surfaced in Settings as the **Stack** panel. `backend/ws/stack/`:

| Event                              | Purpose                                     |
|------------------------------------|---------------------------------------------|
| `stack:status`              | Detect a single tool: `{ status, recipe, activeSession }` |
| `stack:status-all`          | Hardcoded list `['git','claude','opencode','copilot','codex','qwen','pi','cline','cursor','chrome']` (host tools + on-demand engine SDKs) |
| `stack:install-start`       | Spawn the recipe via `install-runner`       |
| `stack:install-cancel`      |                                             |
| `stack:install-session`     | Snapshot session (for re-attach)            |
| `stack:install-started` (emit)  | Session begun                           |
| `stack:install-stream` (emit)   | Per-line stdout/stderr                  |
| `stack:install-finished` (emit) | exit code + final status                |

### 4.5 `models:list` (in `backend/ws/settings/crud.ts`)

```ts
.http('models:list', { data: { engine } }, async ({ data }) => {
  const engine = await initializeEngine(data.engine);
  const models = await engine.getAvailableModels();
  registerModels(data.engine, models);
  return models;
})
```

The handler is **uniform across engines** — no per-engine short-circuits.
Every engine flows through `initializeEngine` → `engine.getAvailableModels()`
→ `registerModels(...)` so the shared in-memory `modelRegistry` is always
populated regardless of whether the catalog is static or dynamic.

> **Why uniform.** The previous version hard-coded `if (engine === 'claude-code') return CLAUDE_CODE_MODELS`
> for static engines. That short-circuit bypassed `registerModels()`, so the
> backend registry stayed empty for static engines and the frontend's
> `getByEngine('claude-code')` returned nothing — the symptom that motivated
> this whole standardization. Don't reintroduce the special case; if a static
> engine's `getAvailableModels()` is too expensive to call repeatedly, cache
> inside the adapter (`CLAUDE_CODE_MODELS` is already a module-level const,
> so the call is free).

Each engine owns its model catalog in `backend/engine/adapters/<engine>/models.ts`:

| Engine        | Catalog kind | Source                                              |
|---------------|--------------|-----------------------------------------------------|
| `claude-code` | static       | hardcoded `CLAUDE_CODE_MODELS` array                |
| `codex`       | static       | hardcoded `CODEX_MODELS` array                      |
| `copilot`     | dynamic      | `client.listModels()` via `fetchCopilotModels`      |
| `opencode`    | dynamic      | `client.config.providers()` via `fetchOpenCodeModels`|
| `qwen`        | dynamic      | OpenAI-compatible `/models` via `fetchQwenModels`   |
| `pi`          | dynamic      | pi-ai runtime catalog via `fetchPiModels`           |
| `cline`       | dynamic      | `Llms.getModelsForProvider()` per stored account, via `fetchClineModels` |
| `cursor`      | dynamic      | `Cursor.models.list()` via `fetchCursorModels` (falls back to `CURSOR_FALLBACK_MODEL_IDS`) |

Failure-mode contract (dynamic engines): return `EngineModel[]` and use
`[]` as the failure sentinel — never `null` (see §2.6). The picker then
renders an empty list rather than a stale cached catalog. `fetchOpenCodeModels`
and `fetchQwenModels` already follow this; new dynamic fetchers must too.

`models.ts` is also where a model advertises its reasoning knob
(`capabilities.reasoningControl` — §2.4a). Dynamic catalogs derive the level
list from the SDK payload (Copilot's `supportedReasoningEfforts`, Pi's
`getSupportedThinkingLevels`, Cursor's model parameters); static catalogs
attach a shared constant. Because the registry is what `resolveGenerationTarget`
reads, `registerModels(...)` here is also what keeps one-shot
`generateStructured` calls from having to re-fetch a catalog.

### 4.6 Engine-specific config (presets — multi-provider / multi-region)

Anything else an engine needs that the frontend has to render — provider
choice, region selection, BYOK templates — also lives with the adapter
rather than `shared/constants/engines.ts`. The canonical filename is
`presets.ts` (see §2.6). Two adapters use this slot:

- **Qwen** (`backend/engine/adapters/qwen/presets.ts`) — `QWEN_PROVIDER_PRESETS`
  array (DashScope CN/INTL, OpenRouter, Fireworks), `DEFAULT_QWEN_PRESET`,
  `getQwenPreset(id)`. Static, hardcoded.
- **OpenCode** (`backend/engine/adapters/opencode/presets.ts`) — the
  models.dev provider catalog: `fetchAndCacheModelsDevCatalog()` +
  `getCachedModelsDevCatalog()`. Dynamic (fetched + cached in `settings`).

The wire-format types (`QwenProviderPresetId`, `QwenProviderPreset`,
`ModelsDevProvider`) live in `shared/types/unified/engine.ts` (or are
re-exported there) so the frontend stays typed without importing from
`$backend`.

Each adapter that has a `presets.ts` ships a thin WS router exposing it:

| Engine    | WS event                                 | Frontend store                                    |
|-----------|------------------------------------------|---------------------------------------------------|
| `qwen`    | `engine:qwen-presets-list`               | `qwenPresetsStore` (`frontend/stores/features/qwen-presets.svelte.ts`) |
| `opencode`| `engine:opencode-models-dev-list` (+ `…-fetch` to refresh) | `opencodeProvidersStore.catalog` (`frontend/stores/features/opencode-providers.svelte.ts`) |

The rule: **frontend never imports `$backend` directly**. Runtime values
the frontend needs (model lists, presets, …) flow through WS endpoints;
types flow through `$shared`.

### 4.7 `chat:stream` — the streaming entry point

`backend/ws/chat/stream.ts` accepts:

```ts
{
  sessionId: string,
  chatSessionId: string,
  projectPath: string,
  prompt: UserMessage,
  engine: { type, provider, model: { id, name }, account: { id, name } },
  sender: { id, name },
  profileId?: number | null,        // null = explicit none; absent = project default
  reasoningEffort?: string | null   // native level token; null/absent = engine default
}
```

The handler calls `streamManager.startStream(...)`, which then:
1. Resolves `getProjectEngine(projectId, engine.type)`
2. Persists the per-session choices that outlive the turn — engine, model,
   account, `profile_id`, `reasoning_effort` — onto the `chat_sessions` row
   (`sessionQueries.updateReasoning`, migration `065`). `undefined` leaves the
   stored value untouched; `null` clears it.
3. Calls `engine.streamQuery({ projectPath, prompt, providerSlug, modelId, reasoningEffort, accountId, mcpContext, ... })`
4. Iterates over `EngineOutput` and emits each one to the chat session room
   via `ws.emit.chatSession(...)`.

The turn's reasoning level is also stamped onto `MessageEngine.reasoningEffort`
by `enrichMessageEngine`, so it shows up in the Raw Message view. It is omitted
(not `null`) when the engine exposes no knob.

#### Collaborative per-session sync events

Choosing a model, account, profile, or reasoning level is a **run choice**, not
an admin mutation — so each one has a matching broadcast-and-persist event that
any session member may send. They are structurally identical; copy the nearest
one when adding a fifth.

| Event                  | Persists to                        |
|------------------------|------------------------------------|
| `chat:model-sync`      | `chat_sessions` engine/model/account |
| `chat:profile-sync`    | `chat_sessions.profile_id`         |
| `chat:reasoning-sync`  | `chat_sessions.reasoning_effort`   |

Each handler calls `requireSessionAccess(conn, chatSessionId)`, writes through
`sessionQueries`, then re-emits to the room via `ws.emit.chatSession(...)`.
Every one of these must be declared in **both** the `.on(...)` block and the
`.emit(...)` schema block at the bottom of `backend/ws/chat/stream.ts` — an
event that is only `.on`'d is received but never broadcast.

Two consequences worth internalising:

- **These persist at *selection* time, not on send.** `chat:model-sync` writes
  `updateEngineModel` the moment anyone picks an engine, which is why
  `chat_sessions.engine` is a trustworthy "currently selected engine" — and
  equally why it is the *wrong* source for "which engine produced this
  message" (read `engine.type` per message instead; see §10.23).
- **The sender ignores its own echo**, so a local pick never comes back through
  the listener. Whatever the remote listener does to
  `sessionState.currentSession`, the local path must do too, or the init
  `$effect` restores the pre-pick values the next time that object is replaced.
  See frontend-and-chat §6.2.

---

