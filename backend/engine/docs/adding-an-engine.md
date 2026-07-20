[← Engine adapter guide](../README.md)

## 9. End-to-end checklist for adding a new engine

The steps below are the same pattern used when the **`copilot`**
(`@github/copilot-sdk`) adapter was added to the repo. Use it as a
blueprint for the next engine you add.

### Stage 1 — Shared types

- [ ] `shared/types/unified/common.ts`: add `'newengine'` to `EngineType`.
- [ ] `shared/types/unified/engine.ts`: add `'newengine'` to `EngineInfo.type`.
- [ ] `shared/types/unified/message.ts`: add `'newengine'` to `MessageEngine.type`.
- [ ] `shared/constants/engines.ts`: add an entry in `ENGINES[]`
      (`type, name, description, icon.light, icon.dark`).
- [ ] `backend/engine/adapters/newengine/models.ts`: own the catalog. Static
      engines export a `NEWENGINE_MODELS: EngineModel[]` array; dynamic
      engines export a fetcher (`fetchNewengineModels(...)`) consumed by
      `getAvailableModels()`. Don't add anything to `shared/constants/engines.ts`
      for the catalog itself — the frontend loads it via `models:list`.
- [ ] (Optional) `backend/engine/adapters/newengine/presets.ts` if the
      engine needs provider/region/BYOK presets exposed to the UI.
      Mirror `qwen/presets.ts`: keep runtime values in the adapter,
      export wire types from `shared/types/unified/engine.ts`, and ship
      a WS endpoint (see Stage 4) — never import these from frontend
      via `$backend`.

### Stage 2 — Adapter `backend/engine/`

Refer to §2.6 for the full file taxonomy. Every adapter ships these five
mandatory files; optional files use the canonical names from §2.6.

- [ ] Create `backend/engine/adapters/newengine/`
- [ ] `index.ts` (mandatory) → `export { NewEngineEngine } from './stream';`
      (+ `disposeXxxClient` if there is a subprocess).
- [ ] `stream.ts` (mandatory) → class `NewEngineEngine implements AIEngine`.
      Pick a template: `claude/stream.ts` (in-process SDK),
      `opencode/stream.ts` (subprocess), `copilot/stream.ts` (in-process
      with construction-time credential), `qwen/stream.ts` (CLI subprocess
      via SDK with auth-blob swap), `pi/stream.ts` (in-process SDK with an
      on-disk session store), or `cline/stream.ts` (in-process, **session-less**
      stateless `Agent`).
- [ ] **Fork / checkpoints (mandatory, easy to miss).** Every resume MUST
      fork so branches don't cross-contaminate — see §10.10. Native-fork SDKs
      pass a flag; on-disk SDKs copy the session file; a **session-less** SDK
      (`cline`) mints a fresh session id per turn and copies the parent
      transcript forward in memory (never reuse the `resume` id as the store
      key). Symptom of getting it wrong: every persisted assistant message
      shares one session id, and an undo+continue answers with the sibling
      branch's history.
- [ ] **Sub-agents (if the engine has no native `Task`/`Agent` tool).** A
      session-less/bare-loop SDK must **synthesize** the `Agent` tool
      (`cline/agent-tool.ts`), register it + `toolPolicies.Agent`, route the
      sub-agent's messages into the stream tagged with `parent.toolUseId`, and
      push **tool_use only** as sub-activities — see §10.15.
- [ ] `models.ts` (mandatory) → static `NEWENGINE_MODELS: EngineModel[]`
      OR `fetchNewengineModels(...): Promise<EngineModel[]>` (dynamic;
      return `[]` on failure — see §4.5).
- [ ] `message-converter.ts` (mandatory) → pure functions SDK → `EngineOutput`.
      Use `toCanonicalToolName()` for tool names.
- [ ] `error-handler.ts` (mandatory) → exports `handleStreamError(error,
      ...): void` (and any helper formatters specific to the SDK's error
      payload — see `opencode/error-handler.ts::formatSessionError` for the
      pattern).
- [ ] `credential.ts` / `environment.ts` / `server.ts` / `config.ts` /
      `presets.ts` / `session-fork.ts` (optional; canonical names only).
- [ ] Artifacts: in `streamQuery`, call `syncSkills(...)` +
      `syncEngineArtifacts(...)` at stream start, and — for a prompt-scoped
      engine — prepend `buildArtifactsPromptContext(...)` to the prompt (from
      `backend/engine/artifact-sync.ts`). Mirror `claude/stream.ts`. See §8.
- [ ] `backend/engine/index.ts`: import + add a case in
      `createEngine(type)`. If there is a shared subprocess, call
      `disposeXxxClient()` from `disposeAllProjectEngines()`.
- [ ] MCP config (if the SDK accepts a streamable-HTTP MCP URL):
      - [ ] Internal bridge — add `getXxxMcpConfig()` in
            `backend/mcp/internal/config.ts` (reuse `clopen-mcp`; see §10.12).
      - [ ] External servers — add `getXxxExternalMcpConfig()` in
            `backend/mcp/external/config.ts` and **forward `headers`** so the
            centralized OAuth bearer reaches the engine. Use the SDK's real
            header field — **Codex uses `http_headers`, not `bearer_token`**.
            See §10.18 and `backend/mcp/README.md`.

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
  - (Optional) `presets.ts` — `engine:newengine-presets-list` if the
    adapter has a `presets.ts` module. See `backend/ws/engine/qwen/presets.ts`.
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

- [ ] Add `frontend/components/settings/engines/panels/NewEnginePanel.svelte`
      and wire it into `AIEnginesSettings.svelte`: its selector tile appears
      automatically (`ENGINES` has the new entry), and the shell renders the
      panel in the `{#if activeEngine === 'newengine'}` branch. Add the
      engine's status shape to `panels/panel-types.ts` and a
      `refreshNewEngineStatus()` in the shell (fetched on mount for the grid,
      passed to the panel as `onRefreshStatus`). Implement the setup flow in
      the panel:
  - Receive `status` + `isLoading` (+ `onRefreshStatus` if it mutates
    accounts) as props; read the account list from its own store.
  - Load status via `ws.http('engine:newengine-status', {})` (in the shell).
  - Subscribe to server-emit events for login progress (in the panel's
    `onMount`, cleaned up in `onDestroy`).
  - After save: `newengineStore.refresh()` + `onRefreshStatus()` +
    `modelStore.refreshModels('newengine')`.
  - If the engine has a browser/device auth flow, factor the auth markup into
    a `{#snippet}` and render it both in the "Add Account" area and in the
    account edit form (in-place re-auth), gated on `newengineReauthAccountId`
    — mirror `ClaudeCodePanel`/`CodexPanel`/`PiPanel`.

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

