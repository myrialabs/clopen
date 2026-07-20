[← Engine adapter guide](../README.md)

## 5. Frontend — Settings UI

### 5.1 Settings → Engines

Files:
- `frontend/components/settings/engines/AIEnginesSettings.svelte` — the shell:
  renders the engine selector grid, fetches every engine's status on mount
  (for the grid badges), and delegates the active engine's card to a panel.
- `frontend/components/settings/engines/panels/` — one self-contained panel
  per engine (`ClaudeCodePanel`, `CopilotPanel`, `CodexPanel`, `QwenPanel`,
  `PiPanel`, `OpenCodePanel`), each owning its own add/edit/delete flow state,
  WS listeners, and dialogs. Shared helpers live alongside them:
  `panel-types.ts` (the per-engine status shapes) and `debug-viewer.ts`
  (the read-only xterm viewer used by Claude + Codex).
- Stores: `frontend/stores/features/claude-accounts.svelte.ts`,
  `frontend/stores/features/copilot-accounts.svelte.ts`,
  `frontend/stores/features/opencode-providers.svelte.ts`

Pattern:
- The shell renders one selector tile **per engine** from the `ENGINES`
  constant in `shared/constants/engines.ts` (icon, name, description) and
  mounts only the active engine's panel. `status` + `isLoading` are passed
  down as props; panels that mutate account state also receive an
  `onRefreshStatus` callback (the shell's per-engine status refresh) so the
  grid's installed/count badges stay current.
- **Re-authentication is in-place**: engines with a browser/device auth flow
  (Claude, Codex, Pi) render that flow *inside the account's edit form*,
  replacing the name field. A shared `{#snippet}` holds the auth-flow markup
  and is rendered both at the bottom "Add Account" area (new accounts) and in
  the edit form (re-auth), gated on `<engine>ReauthAccountId`. Clicking
  **Cancel** in the auth flow returns to the edit form.
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
- **AskUserQuestion**: a standard tool the adapter intercepts **only when
  the SDK exposes a native interactive hook**. Two patterns are in use, plus
  one explicit non-support case:
  1. **In-process callback** (Claude, Qwen) — `claude/stream.ts::canUseTool`
     blocks the SDK until the user answers; Qwen mirrors this with its own
     `canUseTool`.
  2. **SDK event + HTTP fallback** (OpenCode, Copilot) — `opencode/stream.ts`
     listens for `question.asked` and resolves via
     `engine.resolveUserAnswer(toolUseId, answers)`; Copilot parks its
     `onUserInputRequest` callback the same way.
  3. **Unsupported** (Codex) — the `@openai/codex-sdk` exposes no callback
     hook, permission event, or elicitation primitive, so AskUserQuestion
     stays unsupported for Codex until the upstream SDK ships one. There is
     **no** MCP-tool fallback: the previous engine-agnostic MCP path was
     removed (its carrying cost outweighed the benefit). Do not reintroduce
     it — wire the engine's native hook to `resolveUserAnswer` when it
     exists. See §10.12 point 3.

---

