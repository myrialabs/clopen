[← Engine adapter guide](../README.md)

## 9. End-to-end checklist for adding a new engine

The steps below are the same pattern used when the **`copilot`**
(`@github/copilot-sdk`) adapter was added to the repo. Use it as a
blueprint for the next engine you add.

### Stage 1 — Shared types

- [ ] `shared/types/unified/common.ts`: add `'newengine'` to `EngineType`.
- [ ] `shared/types/unified/engine.ts`: add `'newengine'` to `EngineInfo.type`.
- [ ] `shared/types/unified/message.ts`: add `'newengine'` to `MessageEngine.type`.
- [ ] `shared/constants/tool-icons.ts`: add the brand SVG to `TOOL_ICONS`
      (`{ light, dark }`). This is the single source of truth — Settings →
      Engines, Settings → Stack, the wizard, and the chat picker all read it.
- [ ] `shared/constants/engines.ts`: add an entry in `ENGINES[]`
      (`type, name, description, icon: TOOL_ICONS['newengine']`). The array's
      order is the display order everywhere.
- [ ] **Exhaustive `Record<EngineType, …>` maps & unions — forgetting any is a
      compile error, so `bun run check` after this step catches them all:**
  - `shared/constants/engine-tools.ts`: add `'newengine'` to
    `ENGINE_BUILTIN_TOOLS` (its built-in tool names) **and**
    `ENGINE_TOOLS_BEST_EFFORT` (`true` unless the SDK has a real per-tool
    permission hook).
  - `backend/artifacts/types.ts`: add the engine's config-dir slug to
    `ArtifactEngine` **and** `ARTIFACT_ENGINES` (usually the same as the
    `EngineType`; `claude-code`→`claude` is the one exception).
  - `backend/permissions/service.ts`: add the entry to `ENGINE_TYPE_TO_ARTIFACT`
    (+ `ArtifactEngineKey`).
  - `backend/ws/sessions/crud.ts`: add the `'newengine'` literal to the two
    session-engine typebox unions (in addition to the Stage-4 chat/crud ones).
- [ ] `backend/engine/adapters/newengine/models.ts`: own the catalog. Static
      engines export a `NEWENGINE_MODELS: EngineModel[]` array; dynamic
      engines export a fetcher (`fetchNewengineModels(...)`) consumed by
      `getAvailableModels()`. Don't add anything to `shared/constants/engines.ts`
      for the catalog itself — the frontend loads it via `models:list`.
- [ ] (Optional) **Reasoning control.** If the SDK exposes a reasoning /
      thinking / effort knob, attach `capabilities.reasoningControl`
      (`{ levels, default }`) to each model that supports it — build the labels
      with `toReasoningOptions([...])` from `$shared/constants/engines`, and
      read the level list off the SDK payload when it reports one (Copilot, Pi,
      Cursor) rather than hardcoding. Omit the field entirely when there is no
      knob; the picker then hides the control. See §2.4a.
- [ ] (Optional) `backend/engine/adapters/newengine/presets.ts` if the
      engine needs provider/region/BYOK presets exposed to the UI.
      Mirror `qwen/presets.ts`: keep runtime values in the adapter,
      export wire types from `shared/types/unified/engine.ts`, and ship
      a WS endpoint (see Stage 4) — never import these from frontend
      via `$backend`.

### Stage 2 — Adapter `backend/engine/`

Refer to §2.6 for the full file taxonomy. Every adapter ships these five
mandatory files; optional files use the canonical names from §2.6.

> **Lazy-load the SDK — never bundle it.** The engine's SDK package is NOT a
> runtime dependency; it lives in `package.json` `devDependencies` (pinned
> exact) and is installed on demand into `~/.clopen/stack/engines`. In the
> adapter, reference the SDK's types only via `import type` (erased at runtime)
> — **every** file, not just `stream.ts`; a value import left in a helper
> (`server.ts`, `models.ts`, `credential.ts`) resolves from the repo's own
> `node_modules` in dev and only breaks for end users — and resolve the real
> module at point of use with
> `loadEngineSdk<typeof import('<pkg>')>('newengine', '<pkg>')` from
> `backend/engine/sdk-loader.ts`. The loader throws `EngineNotReadyError`
> (`not-installed` / `needs-update`) when the SDK is absent or version-mismatched,
> and the stream-manager surfaces that message in the chat error surface —
> nudging the user to install/update the engine in Settings → Stack. Mirror
> `copilot/stream.ts` / `codex/stream.ts` for the pattern.

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
- [ ] **Parent/background tools (native or synthetic).** Emit the canonical
      parent before its children and stamp the parent tool call id onto every
      child before yielding it. Suppress child partial deltas when they lack a
      parent id. If activity arrives through a side channel, bridge its native
      notifications into the stream with an event queue—never timer polling—
      retain offsets/timestamps, continue through terminal run status, and
      clean up listeners in `finally`. Verify that a child can never replace a
      root frontend placeholder. See §10.15 and frontend-and-chat §6.5.
- [ ] `models.ts` (mandatory) → static `NEWENGINE_MODELS: EngineModel[]`
      OR `fetchNewengineModels(...): Promise<EngineModel[]>` (dynamic;
      return `[]` on failure — see §4.5).
- [ ] `message-converter.ts` (mandatory) → pure functions SDK → `EngineOutput`.
      Use `toCanonicalToolName()` for tool names. **Before writing it, capture the
      SDK's REAL runtime shapes** — a throwaway script that runs one agent and
      `JSON.stringify`s each stream event, tool arg, and tool result (using the
      model the user will run). `.d.ts` types routinely mislead on: whether the
      stream is per-chunk deltas vs snapshots, the actual tool-arg field names,
      whether a payload lives in the args or the result, tool-name wrapping
      (`mcp`-style), and result envelopes (`{status,value}` / images). See
      **§10.20** for the full catalogue of these traps.
- [ ] **Usage that arrives once per turn:** if the SDK emits a single `usage`
      event after all messages (Codex, Cursor), assistant rows persist
      `usage:null` — add the engine to `stream-manager.ts::backfillUsageForStream`'s
      gate so the turn aggregate is written to every assistant row (see §10.20-I).
- [ ] **Reasoning effort (if the SDK has a knob):** read `options.reasoningEffort`
      in `streamQuery` and map it onto the SDK's own option. Treat it as
      untrusted — clamp/ignore an unknown token and fall back to the engine
      default rather than forwarding it. See §2.4a for the per-engine table.
- [ ] **Context window:** set `EngineModel.limit.input` to the model's real max
      when the catalog provides it; leave `0` when it doesn't — do NOT hard-code a
      value. The UI renders `0` as "?" via `getContextUsage(...).unknown` (§10.20-J).
- [ ] `error-handler.ts` (mandatory) → exports `handleStreamError(error,
      ...): void` (and any helper formatters specific to the SDK's error
      payload — see `opencode/error-handler.ts::formatSessionError` for the
      pattern).
- [ ] `generateStructured` (optional but expected — it powers AI commit
      messages, branch names, and artifact authoring). Native-schema SDKs pass
      the schema through; the rest use `buildJsonPrompt` + `extractJson` from
      `backend/engine/structured-helpers.ts` on a tool-less one-shot run.
      Leave the method `undefined` if the SDK genuinely can't do it — the WS
      handlers guard on its presence. See §10.16.
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

### Stage 7 — Settings → Stack

Engine SDKs are installed **on demand** into the clopen-managed stack dir
(`~/.clopen/stack/engines`), not onto the machine's PATH — so you don't write a
per-platform recipe. You only declare the pinned package(s); `resolveEngineRecipe()`
handles the install.

- [ ] `package.json`: add the engine's SDK package(s) to `devDependencies` at an
      **exact** pinned version — this is the single source of truth for the
      version clopen installs on demand.
- [ ] `backend/engine/install-recipes.ts`:
  - Add `'newengine'` to `ToolId`.
  - Add its package(s) to `ENGINE_PACKAGES` (first entry = the SDK clopen
    imports and detects install-state from; any extras pin a transitive CLI the
    SDK would otherwise float, e.g. Copilot's `@github/copilot`).
  - No resolver needed — `resolveEngineRecipe()` picks it up.
- [ ] `backend/ws/stack/status.ts` & `install.ts`: add
      `'newengine'` to `TOOL_UNION`.
- [ ] `frontend/components/settings/stack/StackSettings.svelte`:
      `<ToolInstallCard tool="newengine" title="NewEngine" description="..." />`.

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
      `ENGINES`, and its position in the shared `ENGINES` order is the order
      used by every grid, tab strip, and picker (Stack card list included).
- [ ] The reasoning-level pill appears automatically for any model whose
      catalog entry carries `capabilities.reasoningControl` — no frontend
      change, and no engine name in the component.
- [ ] The engine's brand icon comes from the single `TOOL_ICONS` registry in
      `shared/constants/tool-icons.ts`, which both `ENGINES` and the Stack
      cards reference. Add the SVG **there only** — never inline it a second
      time.
- [ ] **Declare what the adapter really forwards** in
      `backend/chat/engine-handoff.ts::attachmentSupport` (`ADAPTER_IMAGE` /
      `ADAPTER_DOCUMENT`). These are `Record<EngineType, boolean>`, so a new
      engine won't type-check until both are filled in — deliberately. Answer
      from the adapter's own prompt-building code, **not** from
      `models.ts`: the catalog says what the *model* accepts, this table says
      what the *adapter* actually sends, and they routinely disagree. Getting
      it wrong makes a cross-engine switch silently lose the user's images.
- [ ] Verify: select engine → model list appears → send message → stream
      runs.

### Stage 9 — Manual QA

From the project root:

```sh
bun run check && bun run lint
```

Then the minimum UI scenarios that must pass:

- [ ] Settings → Stack → Install NewEngine → exit 0 (SDK lands in
      `~/.clopen/stack/engines`, status shows the pinned version).
- [ ] Settings → Engines → NewEngine → Add Account → status `Installed,
      Active account: <name>`.
- [ ] Chat input → pick NewEngine + model → send a message → assistant
      replies → cancel mid-stream → idle → send again → resume works.
- [ ] AskUserQuestion (if the SDK supports it) → appears in UI → submit
      answer → stream continues.
- [ ] Reasoning effort (if the engine has a knob) → the pill appears for
      models that advertise one and is **absent** for models that don't →
      pick a level → the Raw Message view shows `engine.reasoningEffort` →
      the level survives a refresh (persisted on the session row).
- [ ] `generateStructured` on a **non-Claude** engine: Git → generate commit
      message, and Artifacts → generate from a purpose. These are the two
      paths that break on a stale `providerSlug` and on JSON with trailing
      prose / raw newlines — Claude Code passing proves nothing (§10.16).
- [ ] **Cross-engine handoff, both directions.** Run a few turns on another
      engine (include a tool call and an image), switch to NewEngine, then ask
      something that can only be answered from the earlier turns — it must
      answer without asking the user to repeat themselves. Then switch back
      and confirm the same. The `chat` debug log prints one
      `Engine handoff <from> → <to>` line per switch with the turn count and
      what was cleared or omitted (§10.23).
- [ ] Restart Clopen → state survives (account, provider, last-used model
      in chat).

---
