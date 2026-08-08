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

### 5.2 Settings → Stack

Files:
- `frontend/components/settings/stack/StackSettings.svelte`
- `frontend/components/settings/stack/ToolInstallCard.svelte`

`StackSettings` renders one `ToolInstallCard` per tool — host tools
(`git`, `chrome`, `cloudflared`) plus every engine SDK (`claude`, `opencode`,
`copilot`, `codex`, `qwen`, `pi`, `cline`, `cursor`). `ToolInstallCard`:

1. Calls `stack:status` on mount.
2. Renders: status (installed/version/source; engines also carry
   `requiredVersion` + `needsUpdate`), an "Install" button if
   `recipe.autoInstallable`, otherwise a "Manual install" dialog.
3. While installing: `stack:install-start` → subscribe to
   `stack:install-stream` (per-line) → render in xterm + show
   exit status from `stack:install-finished`.
4. The session survives navigation: if `activeSession` exists on refresh,
   re-attach to the same session id.

Cards are **collapsible** — a compact status row by default, expanding to
version + actions + live install output, and auto-expanding while an install
runs (the list stays scannable as engines are added). The header's brand icon
comes from `TOOL_ICONS` (`shared/constants/tool-icons.ts`), the same registry
`ENGINES` reads — no SVG is defined twice.

Engine cards differ from host-tool cards:
- The SDK installs on demand into `~/.clopen/stack/engines` (managed dir), not
  the machine's PATH; there is no manual command to run.
- The **"Check for Updates"** button is hidden — engine versions are pinned in
  `package.json` and move in lockstep with clopen, so there is no upstream to
  check. When the installed version ≠ the pinned version, the card shows
  **"Update required"** and an `Update → <version>` button instead.

To add a new **host** tool (e.g. `goose`):
1. Add the literal to `ToolId` (`backend/engine/install-recipes.ts`).
2. Add `resolveGooseRecipe()` + a case in `resolveRecipe()`.
3. Add the literal to `TOOL_UNION` (`backend/ws/stack/status.ts`
   and `install.ts`).
4. Add `<ToolInstallCard tool="goose" title="Goose" description="…" />`
   in `StackSettings.svelte`.
5. (Optional) expose detection in the `engine:<name>-status` handler so
   Settings → Engines can show an "Installed" badge.

For a new **engine SDK**, you declare the pinned package instead of a resolver —
see [stack](./stack.md) §7.7.

### 5.3 Settings → Models

`frontend/components/settings/model/EngineModelPicker.svelte` is the shared
catalog browser mounted by `AssistantSettings`, `GitSettings`, and
`ArtifactsSettings` (it is a different component from the chat-input picker of
the same name — see §6.2).

Per-model reasoning defaults are edited here: each model row that carries a
`reasoningControl` (§2.4a) gets a nested row of level buttons, rendered
**whether or not the model is selected** so it can't read as a global setting.
Clicking one calls `setReasoningDefault(modelId, level)` →
`settings.reasoningDefaults` (`null` deletes the key → back to the model's own
default). The chat pill writes the same map, so a level chosen in either place
is remembered in both.

The two generator overrides (`commitGenerator`, `artifactGenerator`) persist
`engine` + `provider` + `modelId` + `modelName` as separate fields. `GitSettings`
and `ArtifactsSettings` write them through `modelFieldsOf(...)` (§6.1) — never
one at a time.

---

## 6. Chat integration — model picker & stream

### 6.1 chat-input state

`frontend/stores/ui/chat-model.svelte.ts` — `chatModelState`:

```ts
{ engine, provider, modelId, modelName,
  engineModelMemory: { [engine]: { provider, id, name } },
  accountId, accountName,
  profileId,          // null = use the project default
  reasoningEffort }   // native level token; null = engine/model default
```

This store is **local to the active session**: settings under Settings →
Engines only seed the initial defaults via `initChatModel(...)`. Switching
engine/model in chat input does **not** affect Settings.

`reasoningEffort` is the one field that is deliberately kept at its
**effective** value rather than "only what the user picked": an `$effect` in
the picker re-seeds it whenever the model changes (per-model default from
Settings → the model's own `reasoningControl.default`) and clears it to `null`
for models with no knob. That way the value sent with the turn — and stamped
onto the message for the Raw view — always matches what actually ran, and a
level left over from a different model can never leak into the next request.

> **Engine/provider/model move together.** They are three fields describing one
> choice; anything that writes one must write all three. Use `modelFieldsOf(...)`
> from `frontend/utils/model-override.ts` for the Settings-persisted
> generator configs (Git, Artifacts) instead of assigning them individually —
> a stale `provider` is invisible on five engines and fatal on three (see
> §10.16 point 3).

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
- **Reasoning-level pill** — rendered next to the model trigger **only** when
  `currentModel.capabilities.reasoningControl` exists (§2.4a). Options come
  straight from `reasoningControl.levels`; no engine is named anywhere in the
  component. Picking a level does three things: sets
  `chatModelState.reasoningEffort`, saves it as that model's default via
  `setReasoningDefault(modelId, value)`, and broadcasts
  `chat:reasoning-sync` to the session room.
- **Not-installed notice** — when `models:list` reports a readiness error for
  the active engine (`modelStore.getError(engine)`, typically
  `EngineNotReadyError`), the picker renders the same actionable notice as
  Settings, with an **Open Stack** button and a Configure-engine fallback.
  Both are admin-gated.
- **No engine lock.** The engine is switchable at any point in a session; only
  an in-flight stream disables the trigger. Mid-session switches are handled by
  the cross-engine handoff (§6.2a). `ProfilePicker` is likewise unlocked — the
  backend resolves the effective profile per stream.

> **Local picks must mirror onto `sessionState.currentSession`.** The init
> `$effect` restores engine/model/account/profile from the session object, and
> it re-runs whenever that object is replaced — which any collaborator's
> `chat:*-sync` broadcast does. The remote `chat:model-sync` listener already
> mirrors ("so init $effect won't overwrite on re-render"); the local path must
> too, because the sender ignores its own broadcast echo. Miss this and a
> user's pick silently reverts a moment later. `selectEngine`, `selectModel`
> and `ProfilePicker.select` all call through this mirror.

### 6.2a Cross-engine handoff

Switching engine mid-conversation is supported. The mechanism lives entirely in
`backend/chat/engine-handoff.ts` — **no adapter, `AIEngine` or migration
change**.

Continuity is normally delegated to each engine's native session store, and
those ids are not portable (a Claude session id, a Codex rollout file, an
OpenCode server session, Cline's in-memory transcript). So when the branch's
trailing engine differs from the requested one, `stream-manager`:

1. **Suppresses `resume`.** `resolveBranchEngine(chatSessionId)` walks back to
   the most recent **non-user** message and reads its `engine.type` (user
   messages carry the *sender's* choice, which is exactly what must not be
   trusted). Falls back to `chat_sessions.engine`, which is reliable because
   `chat:model-sync` persists it at *selection* time, not on send.
2. **Replays the branch as prompt content** via `buildEngineHandoff(...)`,
   prepended to the **engine prompt only**. The persisted `UserMessage` is
   untouched, so the transcript never reaches the DB or the timeline.

**The rule — one rule, no fallback ladder.** Replay verbatim; when the replay
exceeds the trigger, tool results older than the last N tool uses become a
placeholder and tool *inputs* are always kept. Both numbers are the shipped
defaults of Anthropic's [`clear_tool_uses_20250919`](https://platform.claude.com/docs/en/build-with-claude/context-editing)
context-editing strategy (trigger 100k input tokens, keep 3 tool uses,
`clear_tool_inputs: false`). Mirroring a measured default beats inventing a
heuristic — context editing alone reports +29% on agentic benchmarks and an 84%
token reduction on long tool-heavy runs.

> ⚠️ **Do NOT key the replay window on `compact_boundary`.** It looks like the
> natural boundary and it is not: only the **Claude** adapter ever emits one.
> OpenCode drops compaction events (`message-converter.ts`, "Skip: … compaction")
> and Pi disables compaction outright (`compaction: { enabled: false }`). A
> boundary-based window silently degenerates to "replay everything from message
> one" on 7 of 8 engines — precisely the unbounded case it was meant to prevent.

Two further invariants the builder upholds:

- **Exclude the turn's own user message.** It is already saved and *is* the
  branch head by the time the handoff runs, so without `excludeMessageId` the
  transcript ends with a copy of the message the engine is about to answer.
- **Attachments pass two independent gates** — `modalities.input.image` / `.pdf`
  (what the *model* accepts) **and** an adapter table (what the adapter actually
  forwards). They genuinely differ: Codex, Cursor, Pi and Cline have no document
  path at all, so a PDF handed to them vanishes whatever the catalog claims.
  Unsupported attachments degrade to the same placeholder as cleared tool
  results.

After the handoff turn the new engine has minted its own session id, so every
subsequent turn resumes natively — the cost is paid once per switch.

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
  sender: { id, name },
  profileId: chatModelState.profileId,
  reasoningEffort: chatModelState.reasoningEffort,
});
```

Backend `chat:stream` then `streamManager.startStream(...)`, which:
- Resolves `getProjectEngine(projectId, engine.type)`
- Persists engine/model/account + `profile_id` + `reasoning_effort` onto the
  `chat_sessions` row so a refresh or a late joiner restores the same setup
- Calls `engine.streamQuery({ projectPath, prompt, providerSlug: engine.provider, modelId: engine.model.id, reasoningEffort, accountId: engine.account.id !== 0 ? engine.account.id : undefined, mcpContext })`
- Yields `EngineOutput` → emits `chat:message` / `chat:partial` /
  `chat:notification` to the session room.

> **`accountId !== 0`** is the convention for "use override". `0` means
> "fall back to the active account in DB". Account-aware adapters
> (`claude`, `copilot`) read this and override their per-stream credential
> accordingly.

### 6.4 Reasoning, attachments, AskUserQuestion

- **Reasoning (output)**: an adapter must emit
  `StreamLifecycleEvent { reasoning: true }` to mark start/stop of the
  thinking block, then `TextDeltaEvent { reasoning: true }` for each delta.
  The frontend renders these in a separate bubble.
- **Reasoning effort (input)**: the level the user picked rides the request as
  `EngineQueryOptions.reasoningEffort` and is mapped to the SDK's own knob by
  the adapter (§2.4a). Three places hold a value, in precedence order:
  `chatModelState.reasoningEffort` (this session) → `settings.reasoningDefaults[modelId]`
  (per-model, Settings → Models) → `reasoningControl.default` (the model's own).
  Nothing in the frontend branches on engine type — a model without a
  `reasoningControl` simply has no pill.
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

### 6.5 Parent tools and root-placeholder isolation

`Agent`, `Workflow`, and future background/delegation tools use
`parent.toolUseId` as their placement contract:

- The parent assistant message contains the canonical parent `tool_use` block.
- Every child assistant/user message carries that block's id in
  `message.parent.toolUseId` from its first WebSocket emission.
- `groupMessages()` removes those child rows from the root timeline and stores
  them in `subAgentMap[parentToolUseId]`.
- `processToolMessage()` converts the collected child messages into the
  parent's `subActivities`.

The live message handler must preserve that contract before Svelte renders a
frame. In `chat.service.ts::handleMessageEvent`, only a root assistant
(`!message.parent?.toolUseId`) may replace the root non-reasoning
`stream_event` placeholder. A parent-tagged assistant is appended intact so
the grouper consumes it immediately. Do not insert a child at root with the
intention of moving it later; transitions and reactive passes make that move
visible as flicker.

Current transient `stream_event` messages do not carry parent metadata.
Adapters must therefore suppress child text/reasoning deltas and emit
finalized parent-tagged messages, unless the unified stream protocol is first
extended to make placeholders parent-aware end to end.

For a file-backed producer such as Claude Workflow, the adapter watches the
transcript source and pushes complete parent-tagged messages through the same
engine output stream. The frontend should not know whether activity came from
an SDK event or a filesystem event; grouping behavior must be identical to
Agent/Task.

---
