[← Engine adapter guide](../README.md)

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

| Adapter   | How                                                                                          |
|-----------|----------------------------------------------------------------------------------------------|
| Claude    | Pass `forkSession: true` in the SDK options on every call — native.                          |
| OpenCode  | Call `client.session.fork({ path: { id: resume } })` on every resume — native.               |
| Copilot   | Call `client.rpc.sessions.fork({ sessionId: resume })` on every resume — native (`@experimental`, added in `@github/copilot-sdk` 1.0.0-beta.4). |
| Codex     | **No native API yet** — fork by copying the rollout JSONL FILE on every resume.              |
| Qwen Code | **No native API yet** — fork by copying the chat JSONL FILE on every resume.                 |

> **Sharp edge — fork is NOT gated on `EngineQueryOptions.forkSession`.**
> The `forkSession` field exists on the type but the stream-manager
> never sets it; Claude/OpenCode hard-code their fork call. Every other
> adapter must do the same. If you only fork "when forkSession is true"
> the same session id is reused across every turn (visible in persisted
> assistant messages) and downstream branch logic breaks.

The two remaining on-disk workarounds (Codex and Qwen) follow the same
shape — copy the state, replace the source id with a fresh one, then
resume against the fork — but the SDKs lay state out differently. Get
the layout wrong and `sessionStateExists()` silently returns false on
every turn, the fork block is skipped, and the engine resumes the
original session — exactly the symptom multi-branch checkpoints
surface as.

**Codex — single rollout JSONL in a date-tree.** The thread id is in
the filename, not a directory name:

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl
```

The fork helper walks the date-tree to find the source by
`-<thread_id>.jsonl` suffix, copies it into TODAY's `YYYY/MM/DD` dir
under a new `rollout-<now>-<forkId>.jsonl` filename, and replaces every
occurrence of the source id (UUIDs don't collide with other content in
the file). Earlier versions of `codex/session-fork.ts` mistakenly
assumed a directory layout (`~/.codex/sessions/<thread_id>/`) — the
result was a permanently-broken fork because `sessionStateExists()`
never matched. If you change the helper, watch for that regression.

**Qwen Code — single chat JSONL keyed by sanitised cwd.** The chat id
is the filename basename; the parent directory is derived from the
project's cwd via the SDK's `sanitizeCwd()`
(`cwd.replace(/[^a-zA-Z0-9]/g, '-')`, lowercased on win32):

```
~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
```

Every record line carries a `sessionId` field equal to the file's
basename. The fork helper copies the file to
`<chats>/<forkId>.jsonl` in the same project directory and replaces
the source id throughout. The Qwen `session-fork.ts` therefore takes
`projectPath` as an extra argument — Codex and Copilot are
cwd-agnostic because their layouts aren't keyed on it.

```ts
// stream.ts (resume path) — fork on EVERY resume; pattern is identical
// across copilot/codex/qwen, only the helper signature differs.
let resumeId = resume;
if (resume && sessionStateExists(/* projectPath if qwen, */ resume)) {
  const forkId = crypto.randomUUID();
  if (forkXxxSessionState(/* projectPath if qwen, */ resume, forkId)) {
    resumeId = forkId;
  }
}
// then pass resumeId to the SDK's resume entry point.
```

The expected effect, observable by logging the session/thread id per
turn:

```
turn 1   user → assistant   sessionId: A
turn 2   user → assistant   sessionId: B   (forked from A)
turn 3   user → assistant   sessionId: C   (forked from B)
```

Every assistant message carries its **own** session id. Reusing the
same id across turns is the symptom that forking is gated or skipped.

When an SDK eventually adds a native `forkSession` (or equivalent), the
migration is a one-liner: delete that adapter's `session-fork.ts`, drop
the fork block in `stream.ts`, and pass the SDK flag the same way
Claude, OpenCode, and Copilot already do. The `// TODO` comment at the
top of each `session-fork.ts` pins the migration target.

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

### 9.12 Reuse the existing MCP HTTP infrastructure — never build a new bridge

`backend/mcp/remote-server.ts` already mounts every server registered via
`defineServer()` as a **Streamable HTTP MCP** endpoint at
`http://localhost:<port>/mcp`. OpenCode consumes it via
`getOpenCodeMcpConfig()`. Tool handlers run **in-process** in the Clopen
backend — there is no subprocess, no per-engine HTTP listener, no
per-stream MCP path. Project context propagates via
`projectContextService` (AsyncLocalStorage with a `mostRecentActiveStream`
fallback when the transport doesn't preserve the context).

When you add an engine whose CLI/SDK accepts a streamable-http MCP URL
(e.g. Codex, Copilot):

1. Add a sibling helper next to `getOpenCodeMcpConfig()` —
   `getXxxMcpConfig()` — that returns the **same** URL in the engine's
   expected shape (Codex format: `{ '<server-name>': { url: '...' } }`;
   Copilot format: `{ '<server-name>': { type: 'http', url: '...', tools: [...] } }`).
   The engine sees every enabled MCP server (`browser-automation`,
   `weather-service`, …) as one logical MCP server namespace exposing all
   the tools.

   **Naming conventions for the helper** (mirror the existing two so the
   reviewer doesn't ping you twice):
   - Use the SDK's **exported type** for the return shape if one exists
     — e.g. Open Code's `McpRemoteConfig` from `@opencode-ai/sdk`,
     Copilot's `MCPHTTPServerConfig` from `@github/copilot-sdk`. Only
     define a local type alias when the SDK doesn't export one (Codex).
   - Reuse the `'clopen-mcp'` namespace key. Don't invent a new one
     per engine — the tool-name resolver below depends on it.
   - In the adapter, name the local variable holding the helper's return
     value **`mcpConfig`**, not `mcpServers`. The latter shadows both the
     SDK's config field name AND the registry exported from
     `backend/mcp/config.ts`, and reads as a bug at the call site.

2. Use `resolveOpenCodeToolName()` (in `backend/mcp/config.ts`) on
   incoming tool names; it strips the `clopen-mcp_` / `clopen-mcp-`
   prefix and reverse-maps to `mcp__<server>__<tool>`. The same helper
   works for any engine that uses the same naming convention.

   **Engines DO NOT agree on the prefix separator.** Open Code joins the
   server-config key to the tool name with `_` (`clopen-mcp_open_new_tab`);
   Copilot joins with `-` (`clopen-mcp-open_new_tab`); Codex emits a bare
   tool name and carries the server name separately on the event payload.
   `resolveOpenCodeToolName()` strips **both** `clopen-mcp_` and
   `clopen-mcp-` prefixes for this reason. If a new engine introduces yet
   another separator, extend the prefix list in that helper — do **not**
   add a parallel resolver in the adapter.

   The symptom of skipping this step is a tool that renders in the UI
   with the doubled-up name `mcp__clopen-mcp__clopen-mcp-<tool>` instead
   of `mcp__<server>__<tool>` — the prefix didn't strip and the registry
   lookup fell through to the `mcp__<mcpServerName>__<rawName>` fallback.

3. If your engine has **no callback hook** for AskUserQuestion (Codex's
   SDK is the canonical example), AskUserQuestion stays unsupported for
   that engine until the upstream SDK exposes a native primitive. The
   previous engine-agnostic MCP fallback (`ask-user-question` tool +
   stream-keyed pending registry) was removed once the carrying cost —
   AsyncLocalStorage plumbing, dual resolve paths in
   `backend/ws/chat/stream.ts`, manual cancel-aborts — outweighed the
   benefit. Wire the engine's native hook to `resolveUserAnswer` when it
   ships; do not reintroduce a parallel MCP path.

4. Auto-approval of MCP tool calls is **per-engine**, not centralised.
   Each SDK exposes its own approval surface and they are not
   interchangeable:
   - Claude Code: `canUseTool` returns `{ behavior: 'allow' }` for all
     non-AskUserQuestion tools (already handled by the adapter).
   - Open Code: replies `'once'` to `permission.asked` events at runtime
     via `autoApprovePermission()`.
   - Codex: enumerates every enabled tool with `approval_mode: 'approve'`
     in the per-server config — `codex exec` is non-interactive and has
     no runtime approval channel, so the decision must be baked in
     up-front.
   - Copilot: `onPermissionRequest: approveAll` covers MCP tools
     too — no per-tool enumeration needed.

   Wire whichever path exists; do not assume Codex-style enumeration is
   required when a runtime hook is available, and do not assume runtime
   approval works when only static config is offered.

What you must NOT do:
- ❌ A second HTTP listener (e.g. "MCP HTTP bridge for Codex"). Reuse `/mcp`.
- ❌ Per-engine MCP servers in `backend/mcp/servers/` (e.g. one folder
  per engine). All MCP servers are engine-agnostic and registered via
  `defineServer()` once.
- ❌ Per-stream bearer tokens or unique URLs. Authorization piggy-backs
  on `projectContextService` exactly like the Claude in-process path.
- ❌ A new namespace key in `getXxxMcpConfig()` (e.g. `'copilot-mcp'`).
  Always use `'clopen-mcp'` — `resolveOpenCodeToolName()` keys off it.
- ❌ A local type alias when the SDK exports the type (Open Code,
  Copilot). Import `McpRemoteConfig` / `MCPHTTPServerConfig` directly.

### 9.13 Auth-blob swap into a shared CLI dotfile (vs. per-account isolated dirs)

When a CLI hard-codes its credential location (Codex reads
`~/.codex/auth.json`; Gemini CLI reads `~/.gemini/oauth_creds.json`;
etc.), the naïve approach is to give each Clopen account its own
isolated home directory and override the CLI's home env var
(`CODEX_HOME`, `GEMINI_HOME`). **Don't.** That approach has bitten us:

- Session/thread state lives in the same dir tree (`~/.codex/sessions/`,
  `~/.codex/projects/`), so isolating the dir splits session memory,
  breaks fork-by-copy, and loses the user's `config.toml` overrides.
- Token refresh happens in-place in the dotfile — refreshes performed
  inside an isolated dir do not propagate back to the user's "real"
  home unless we add a watcher.
- The CLI's other features (e.g. project trust, `.agents` allowlist)
  expect the dir to be the user's normal one.

**Use the shared-location-with-DB-swap pattern instead:**

| Step | Behavior |
|---|---|
| **Login** | Spawn the CLI's login command (`codex login`, etc.) which writes the user's normal dotfile. On success, **read the dotfile content** and persist it to `engine_accounts.credential` as a JSON wrapper, e.g. `{ kind: 'chatgpt', authJson: '<file content>' }`. |
| **Switch account** | `accounts-switch` handler reads the chosen account's `credential`, parses the wrapper, writes `authJson` **back to the shared dotfile** with an atomic replace (`write to .tmp` + `rename`). |
| **Stream-start** | Adapter ensures the dotfile reflects the right blob (re-write if drift detected; cheap idempotent op). |
| **Stream-end** | Read the dotfile back and snapshot it into the active account's `credential` so any token refresh the CLI performed during the turn survives across switches. |

Trade-off: only **one** Codex/CLI account is "active" on disk at a
time. Concurrent streams from two different accounts will race; UI must
surface only one active account per engine and document the limitation.
For Clopen, that matches existing UI assumptions. If a future engine
genuinely needs concurrent multi-account streams, escalate the trade-off
explicitly — do **not** silently switch to per-account home dirs.

Concurrency caveat: if the login command itself writes to the shared
dotfile (Codex's `codex login` does), serialize the login flows with a
backend-wide mutex so two simultaneous "Add Account" attempts can't
clobber each other.

### 9.14 Long-lived server engines need a "Restart Server" UX

If your engine boots a process or constructs an SDK client that **caches
credentials** beyond a single stream (OpenCode's `opencode serve`
subprocess, Copilot's `CopilotClient` constructor), then add / remove /
switch account does NOT take effect until that cached state is rebuilt.
The fix is the **Restart-Server pattern** documented in §4.2:

1. Add a `*-server-restart` WS event with the standard contract: check
   active streams, return `{ needsConfirmation, activeChats }` when not
   forced; on `force === true`, cancel streams + dispose engine + drop
   any cached subprocess/client; the next `streamQuery` lazy-inits fresh.
2. Surface a **"Restart Server"** button in **two** UI places:
   - **Settings → Engines** — visible after add/remove/switch in the
     engines settings panel itself. Confirmation dialog for non-forced.
   - **Chat Input** — visible next to the model/account picker when the
     user has switched account mid-session. Uses `force: true` so the
     send-flow stays inline. See `EngineModelPicker.svelte::ocNeedsRestart`
     for the flag and `restartOCServer` for the handler.
3. After a successful restart, refresh the model catalog
   (`modelStore.refreshModels(engineType)`) since model availability can
   depend on credential state.

Engines that **do not** need this:

- Subprocess-per-turn engines (Claude Code's `query()`, Codex's
  `codex exec`) re-read credentials at every turn — there is nothing
  cached to invalidate.
- Engines using the auth-blob swap pattern (§9.13) — the swap happens
  inside `accounts-switch`, and the next turn's subprocess picks up the
  new dotfile without a restart event.

If you are tempted to add a `*-server-restart` event for an engine that
spawns a fresh subprocess per turn, you almost certainly want the
auth-blob swap (§9.13) instead — adding the restart event ships dead
code and confuses the UX (button that does nothing observable).

### 9.15 Sub-agent (`Task` / `Agent` tool) routing — name, input, parent id

Every engine SDK we support exposes a "dispatch sub-agent" tool. Each
SDK names it differently (Claude → `Task`, OpenCode → `task`, Copilot →
`task`) and emits the sub-agent's tool calls / messages on the **same
event stream** as the main turn. Without explicit routing those nested
messages render as orphan top-level rows in the UI, and the dispatch
tool itself appears as `Unknown:task`. There are three independent
fixes — miss any one and the symptom shows up in the UI.

**1. Canonicalise the dispatch tool name to `Agent`.** Every adapter
must map its native name into the unified `Agent` block so the frontend
tool renderer (`handleAgentTool`) and `subAgentMap` lookups work:

```ts
// claude/message-converter.ts
const name = block.name === 'Task' ? 'Agent' : block.name;

// opencode + copilot tool-name maps
'task': 'Agent',
```

Then normalise the SDK's raw input fields into `AgentInput { prompt,
description, subagentType }` (see §9.1). Field names vary —
`prompt`/`task`/`instruction`, `agent_type`/`subagent_type`/`agent` —
so the normaliser must accept them all and default `subagentType` to
`'general-purpose'`.

**2. Stamp `parent.toolUseId` on every sub-agent message.** The
frontend grouper (`message-grouper.ts`) routes messages with
`parent.toolUseId !== null` into `subAgentMap[parentToolId]` and
attaches them as `subActivities` on the parent `Agent` tool block.
Top-level messages must keep `parent.toolUseId = null` (see §9.5);
sub-agent messages must carry the **parent dispatch tool's** call id.
Each SDK exposes that linkage differently:

| Engine   | How the parent id is discovered                                  |
|----------|------------------------------------------------------------------|
| Claude   | `msg.parent_tool_use_id` is on every nested SDK message          |
| OpenCode | `convertToolUseOnly` / `convertToolResultOnly` / `convertSubtaskToolUseOnly` take a `parentToolUseId` parameter; the caller threads it through when iterating the subtask part |
| Copilot  | `subagent.started` event carries `data.toolCallId` (parent) and `agentId` (child instance). The converter records `agentParentMap[agentId] = data.toolCallId` and `resolveParentToolUseId(event, state)` resolves later events: `data.parentToolCallId` first (deprecated direct hint), else map lookup by `agentId` |

The converter functions for assistant messages, reasoning messages and
`tool.execution_complete` then accept an optional `parentToolUseId` and
stamp it onto `parent: { ..., toolUseId: parentToolUseId ?? null }`.
On `subagent.completed` / `subagent.failed`, delete the map entry so
the next sub-agent dispatch re-registers cleanly.

**3. Suppress the SDK's sub-agent streaming deltas.** Some SDKs
double-emit sub-agent activity: once as live text/reasoning deltas
inside the main stream, and again as final non-streaming
`assistant.message` / `assistant.reasoning` / `tool.execution_complete`
events scoped to the sub-agent. The deltas have no clean parent
linkage and would leak into the main chat bubble. The fix is to disable
streaming for sub-agents at the SDK config level so only the final
bundled events arrive — those carry `agentId` and route correctly via
step 2 above:

```ts
// copilot/stream.ts — baseConfig
includeSubAgentStreamingEvents: false,
```

If your SDK has no equivalent flag, the fallback is client-side: in the
event switch, `if (parentToolUseId) break` for any
`assistant.turn_start` / text-delta / reasoning-delta lifecycle event,
since those lifecycles belong to the sub-agent and would corrupt the
main turn's stream state.

**Cross-engine consistency.** Once all three fixes are in place, the
frontend treats the three engines identically: the `Agent` block in the
main timeline carries `subActivities`, no orphan top-level messages
appear, and the dispatch tool's name renders as `Agent`. If only step 1
ships, sub-agent tool calls float to the top of the chat. If only step
2 ships, the dispatch tool still says `Unknown:task`. If only step 3 is
missed (in an SDK that does double-emit), sub-agent text appears in
both places.

### 9.16 `generateStructured` — schema strictness & part-extraction fallback

`generateStructured` powers the AI commit-message generator (and any
future one-shot JSON callers). Each adapter satisfies the same
`StructuredGenerationOptions → Promise<T>` contract, but the SDKs split
sharply on whether they accept a schema natively:

| Engine       | Strategy        | Mechanism                                                    |
|--------------|-----------------|--------------------------------------------------------------|
| Claude       | Native          | `outputFormat: { type: 'json_schema', schema }` on `query()` |
| Codex        | Native (strict) | `Thread.run(prompt, { outputSchema })` → `Turn.finalResponse`|
| OpenCode     | Prompt          | `client.session.prompt({ tools: {}, … })`, parse text/reasoning parts |
| Copilot      | Prompt          | `createSession({ availableTools: [], streaming: false })` + `sendAndWait` |
| Qwen         | Prompt          | `query({ coreTools: [], maxSessionTurns: 1 })`, read `SDKResultMessageSuccess.result` |

**Two cross-cutting gotchas you will hit.**

**1. OpenAI strict mode demands a fully-closed schema.** Codex (via the
Responses API) rejects any object that omits `additionalProperties:
false` (`invalid_request_error / invalid_json_schema`) and requires
every property to appear in `required`. Optional fields must be
expressed as nullable type unions, not absent from `required`:

```ts
// backend/ws/git/commit-message.ts — shape that satisfies Codex.
{
  type: 'object',
  additionalProperties: false,
  required: ['type', 'scope', 'subject', 'body'],
  properties: {
    type:    { type: 'string', enum: [...] },
    scope:   { type: ['string', 'null'] },   // was just 'string'
    subject: { type: 'string' },
    body:    { type: ['string', 'null'] },
  },
}
```

This is the **lowest common denominator** — Claude, OpenCode, Copilot,
and Qwen all accept the same shape, so authoring all
`generateStructured` schemas to Codex's rules keeps the call site
engine-agnostic. Don't lift constraints into the adapter; lift the
schema in the caller.

The consumer of the parsed JSON must then handle `null` for any field
that used to be "absent" — the existing falsy guards in
`commit-message.ts` (`result.scope ? …`, `result.body ? …`) already do
that. The corresponding TS type in `shared/types/git.ts` mirrors this
(`scope: string | null`).

**2. Prompt-engineered engines can return empty `text` parts.** OpenCode
in particular emits `reasoning` parts in addition to `text` parts, and
on some thinking-heavy models the JSON answer lands in the reasoning
stream while `text` is empty. The early implementation that filtered
only `p.type === 'text'` raised "OpenCode returned no text content" in
that case.

Two defences, both in `backend/engine/structured-helpers.ts` and the
OpenCode adapter:

- **Fall back across part types.** `text` first, then `reasoning`.
  Filter out `ignored`/`synthetic` parts so the SDK's own scratch text
  doesn't leak into the JSON parser. Log the part-type breakdown in the
  error message so the next failure is diagnosable.
- **Extract JSON tolerantly.** `extractJson()` tries, in order: a
  ` ```json ` fenced block, the first balanced `{ … }`, then the raw
  trimmed text. Models routinely ignore the "no markdown fences"
  instruction; the parser should not.

The native engines (Claude, Codex) skip these — Claude exposes
`structured_output` on the `result` message and Codex's
`Turn.finalResponse` is already the JSON string. They only fall through
to `extractJson` defensively against the (rare) `finalResponse` arriving
fenced.

**Cancellation.** Every adapter accepts `options.abortController` and
hands its `signal` to whatever the SDK exposes (Codex
`TurnOptions.signal`, Claude `Options.abortController`, OpenCode `prompt
{ signal }`, Copilot `session.abort()`, Qwen `QueryOptions.abortController`).
The contract is the same as `streamQuery`: aborting cancels the in-flight
request, not just the await.

**Engine-not-implemented errors.** `backend/ws/git/commit-message.ts`
guards on `engine.generateStructured` — if you add an engine that can't
implement structured output, leave the property `undefined` and the WS
route will surface `Engine "<name>" does not support structured
generation` cleanly.

### 9.17 OpenCode SDK v1 vs v2 — events come from the binary, not the npm types

`@opencode-ai/sdk` ships **two** API surfaces: the root entry (`.` →
`dist/index.js`, the **v1** client the adapter uses today) and a separate
**v2** entry (`@opencode-ai/sdk/v2`). Across the 1.4 → 1.15 jump the v1
*typed* `Event` union was trimmed — `question.asked`, `message.part.delta`,
and `permission.asked` no longer appear in `dist/gen/types.gen.d.ts`; the
typed equivalents (`EventQuestionAsked`, the `session.next*` streaming
events, etc.) now live only under `dist/v2/`.

**This is a typing change, not a protocol change.** The running `opencode
serve` binary (1.15.x) still emits those legacy events on the v1 `/event`
SSE stream and still serves `/question`, `/question/{id}/reply`,
`/permission/{id}/reply` — verify with `curl http://<server>/doc`. The
adapter casts events to `{ type: string; properties }` (untyped), so it
keeps receiving them and AskUserQuestion + reasoning streaming keep
working. **Do not conclude a feature is "removed" from the SDK npm types
alone — confirm against the binary's OpenAPI doc.**

Consequence: the `question.asked` / `message.part.delta` / `permission.asked`
handlers in `opencode/stream.ts` are correct at runtime but **not**
type-checked against the SDK (the cast hides them). The future-proofing
move — should the binary ever drop the legacy v1 stream in favour of
`session.next*` — is to migrate the adapter onto the typed `@opencode-ai/sdk/v2`
event protocol. Until then, v1 is intentional.

---

