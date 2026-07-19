[← Engine adapter guide](../README.md)

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
   `AIEnginesSettings.svelte::handleRestartServer` (with the
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

Failure-mode contract (dynamic engines): return `EngineModel[]` and use
`[]` as the failure sentinel — never `null` (see §2.6). The picker then
renders an empty list rather than a stale cached catalog. `fetchOpenCodeModels`
and `fetchQwenModels` already follow this; new dynamic fetchers must too.

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
  sender: { id, name }
}
```

The handler calls `streamManager.startStream(...)`, which then:
1. Resolves `getProjectEngine(projectId, engine.type)`
2. Calls `engine.streamQuery({ projectPath, prompt, providerSlug, modelId, accountId, mcpContext, ... })`
3. Iterates over `EngineOutput` and emits each one to the chat session room
   via `ws.emit.chatSession(...)`.

---

