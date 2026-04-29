# PLAN — Codex Engine Adapter

This plan covers the work to add an OpenAI Codex adapter (`@openai/codex-sdk`) to Clopen as a fourth engine alongside `claude-code`, `opencode`, and `copilot`.

It assumes familiarity with `backend/engine/README.md` and `backend/mcp/README.md`. Generic engine-adapter shape, the `AIEngine` contract, the `EngineOutput` event union, the `engine_providers`/`engine_accounts` schema, the standard wiring (WebSocket routes, frontend stores, `EngineModelPicker`, install-recipes), and the existing remote MCP HTTP infrastructure are documented there and are NOT repeated here. This document describes only the Codex-specific decisions and deviations agreed during the planning discussion.

> **Revision note (post-review).** Two earlier analysis errors corrected here:
> - `backend/mcp/remote-server.ts` already exposes Clopen's MCP servers over Streamable HTTP at `/mcp` and OpenCode already consumes it via `getOpenCodeMcpConfig()`. Codex will reuse that exact infrastructure; no new "MCP HTTP bridge" is needed.
> - Multi-account ChatGPT auth uses the shared `~/.codex/auth.json` file. On every successful login we copy the file content into `engine_accounts.credential`; on account switch we write the stored JSON back to `~/.codex/auth.json`. No per-account `CODEX_HOME` directories.

---

## 1. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Engine type literal | `'codex'` |
| 2 | Provider | Single seeded provider `('codex', 'openai', 'OpenAI')` |
| 3 | SDK shape | In-process `Codex` instance per project (subprocess `codex exec` is spawned by the SDK per turn — we don't manage it directly) |
| 4 | Models | Static catalog in `shared/constants/engines.ts` (mirrors `CLAUDE_CODE_MODELS`) — see §6 |
| 5 | Sandbox | `sandboxMode: 'workspace-write'` |
| 6 | Approval | `approvalPolicy: 'never'` |
| 7 | Reasoning effort | Hardcoded `'medium'` for MVP |
| 8 | Network access | `network_access = true` in `[sandbox_workspace_write]` (consistent with how Claude/OpenCode/Copilot run today; rationale in §7) |
| 9 | Web search | `webSearchMode: 'cached'` (default) |
| 10 | Working dir | Per-thread `workingDirectory` + `skipGitRepoCheck: true` (Clopen validates projects) |
| 11 | Cancel | Local `AbortController` first, then drop iterator (no separate RPC — SDK honors `signal` in `TurnOptions`) |
| 12 | Fork session | Copy `~/.codex/sessions/<id>/` directory on every resume — same on-disk pattern as Copilot (`copilot/session-fork.ts`) |
| 13 | Install recipe | `bun add -g @openai/codex` |
| 14 | Auth flows | **Dual** — API key (paste) AND ChatGPT browser OAuth. Multi-account via **shared `~/.codex/auth.json` swapped from DB on account switch**. Detail in §3 |
| 15 | MCP forwarding | **Reuse existing `backend/mcp/remote-server.ts` at `/mcp`** (same Streamable HTTP transport OpenCode uses today). Add a new `getCodexMcpConfig()` helper that emits the URL in Codex's `mcp_servers.<name>.url` config shape. Detail in §2 |
| 16 | AskUserQuestion | Codex SDK exposes no callback hook → implemented as a new in-process MCP server `ask-user-question` registered via `defineServer()` and surfaced through the existing remote MCP endpoint. Tool handler blocks until the user answers in the UI. Depends on §2 |
| 17 | Hooks | User-controlled via `~/.codex/config.toml` — outside adapter scope, no work item |
| 18 | Codex telemetry / OTel | Off by default (SDK default). No work item |

The plan executes in two halves: **§2 (the new `ask-user-question` MCP server + Codex MCP config helper)** and **§3–§7 (the Codex adapter itself)**. §2 is a hard dependency for the adapter because AskUserQuestion is mandatory.

---

## 2. MCP wiring (Stage A)

### 2.1 What already exists (do NOT rebuild)

`backend/mcp/remote-server.ts` exposes every MCP server registered via `defineServer()` over Streamable HTTP at `http://localhost:<port>/mcp`. Tool handlers run **in-process** in the Clopen backend — there is no subprocess and no bridge. Project context propagates via `projectContextService` (AsyncLocalStorage with `mostRecentActiveStream` as a fallback when the transport doesn't preserve the context — same path OpenCode uses today).

`getOpenCodeMcpConfig()` already returns `{ 'clopen-mcp': { type: 'remote', url: 'http://localhost:<port>/mcp', ... } }`. Codex needs an analogous helper that emits the *same* URL in Codex's CLI config shape.

### 2.2 Deliverables

1. **`backend/mcp/servers/ask-user-question/`** — a new in-process MCP server (one tool, `ask_user_question`) defined via `defineServer()` so it lights up automatically in both the Claude SDK path (`getEnabledMcpServers()`) and the remote HTTP path (`createRemoteMcpServer()`). The handler:
   - Resolves the active stream via `projectContextService.getCurrentContext()` (with the existing `mostRecentActiveStream` fallback — same behavior other in-process tools rely on today, see `browser-automation`).
   - Generates a `questionId`, registers a pending answer in a module-local `Map<string, { resolve, reject, abort }>` keyed by `streamId + questionId`.
   - Emits a `chat:partial` event so the chat UI shows the AskUserQuestion bubble (mirrors how Claude's built-in AskUserQuestion currently surfaces, just sourced from an MCP tool result instead of `canUseTool`).
   - Awaits the Promise; resolves on `chat:resolveUserAnswer` (a new WS handler that finds the pending entry and calls `resolve(answer)`); rejects with a structured "cancelled" tool error when the stream's abort signal fires.
   - Returns the answer payload to the MCP caller as a regular tool result (`{ content: [{ type: 'text', text: JSON.stringify(answer) }] }` — schema TBD in implementation).

2. **`getCodexMcpConfig()` in `backend/mcp/config.ts`** — returns Codex's config shape:
   ```ts
   {
     'clopen-mcp': {
       url: `http://localhost:${SERVER_ENV.PORT}/mcp`,
     }
   }
   ```
   The Codex CLI's `--config mcp_servers.<name>.url=...` accepts a Streamable HTTP MCP server. The SDK flattens our `config: { mcp_servers: getCodexMcpConfig() }` into the right CLI flags. Confirmed via Codex MCP docs (`https://developers.openai.com/codex/mcp.md`).

3. **WebSocket route** for the answer:
   - Add `chat:resolveUserAnswer` handler (or reuse the existing one if Claude already has one — verify in implementation). Payload: `{ streamId, questionId, answer }`. Body: look up the pending entry registered by the MCP tool handler and resolve the Promise. No engine method involved — the answer flow is engine-agnostic now.

4. **Tool name canonicalization** — the MCP tool name will be `mcp__ask-user-question__ask_user_question`. The frontend tool registry already routes the canonical name `'AskUserQuestion'` to `AskUserQuestionTool.svelte`. Add a mapping in `toCanonicalToolName()` (`shared/types/unified/tool.ts`) so the MCP variant collapses to `'AskUserQuestion'`. (Single small edit; confirmed during implementation.)

### 2.3 What is explicitly NOT in this stage

- ❌ A new HTTP server / new Bun listener / new `/mcp/<server>/...` paths. Reuse the existing single `/mcp` mount.
- ❌ Per-stream bearer tokens. Tool authorization remains the same as today (project context resolution); if a future engine needs token-scoped isolation, that's a separate concern.
- ❌ Migrating Claude's built-in AskUserQuestion to the MCP variant. Both coexist — Claude keeps its `canUseTool` path; Codex (and any other engine without a callback hook) consumes the MCP variant.

### 2.4 Concurrency note

Multiple Codex turns running concurrently each get their own MCP session via the existing transport (`onsessioninitialized` already creates a fresh `McpServer` per session). The `ask-user-question` pending registry is keyed by `streamId + questionId`, so concurrent streams cannot collide.

---

## 3. Codex authentication & multi-account (Stage B)

### 3.1 Two auth modes

Both modes coexist on the same engine. The user picks per account.

| Mode | What's stored in `engine_accounts.credential` | How it's applied to a stream |
|---|---|---|
| **API key** | JSON string `{"kind":"api_key","apiKey":"sk-…"}` | `new Codex({ apiKey })` — SDK auto-injects `OPENAI_API_KEY` into the spawned subprocess |
| **ChatGPT** | JSON string `{"kind":"chatgpt","authJson":<full ~/.codex/auth.json content>}` | Write `authJson` into `~/.codex/auth.json` before the stream starts; `new Codex({})` (no `apiKey`) — Codex CLI reads the shared file |

`engine_accounts` schema is unchanged (see README §3.1) — `credential TEXT NOT NULL` already accepts JSON. Engine-specific interpretation is precedent (OpenCode's `provider.options` uses JSON too).

### 3.2 Shared `~/.codex/auth.json` swap (per user directive)

Only **one** Codex account is "active" at a time. The active account's `auth.json` content lives in `~/.codex/auth.json`. Switching accounts writes the new account's stored blob to that file.

Lifecycle:

1. **On login (ChatGPT or API key)** — after the credential is captured, copy the resulting `~/.codex/auth.json` content into the new `engine_accounts.credential` row (ChatGPT mode) OR write `{kind:"api_key", apiKey}` directly without touching the filesystem (API key mode).
2. **On account switch** — read `engine_accounts.credential` for the chosen account, parse the JSON wrapper:
   - `kind === 'chatgpt'` → write `authJson` to `~/.codex/auth.json` (atomic replace: write to `~/.codex/auth.json.tmp` then `rename`).
   - `kind === 'api_key'` → leave `~/.codex/auth.json` alone; pass `apiKey` to the SDK options at stream-start time.
3. **At stream start** — adapter resolves the active Codex account via `getActiveAccountForEngine('codex')` (or stream override via `EngineQueryOptions.accountId`), then for each turn: ensure `~/.codex/auth.json` reflects the right blob (re-write if it drifted; cheap idempotent op).
4. **Token refresh** — Codex CLI auto-refreshes ChatGPT tokens by mutating `~/.codex/auth.json` in place. After every stream finishes, read `~/.codex/auth.json` back and persist the (possibly updated) content into the active account's `engine_accounts.credential` so refreshed tokens survive across switches. (Mitigates the "user signed in two days ago, switched accounts and back, refresh token expired" edge case.)

Trade-off accepted (per user): if two Codex streams from different accounts overlap, the second-started stream wins the auth.json. For MVP that's fine — Clopen's UI surfaces only one active account per engine at a time anyway. Document the limitation in README §9.12.

### 3.3 ChatGPT login flow (browser OAuth)

Behavior captured in `log-codex-auth.txt`:
- `codex login` prints a localhost callback URL + an `https://auth.openai.com/...` URL on stdout.
- Browser sign-in writes `~/.codex/auth.json` and the CLI prints `Successfully logged in`.
- Tokens auto-refresh; we just snapshot the file content into the DB.

Adapter implementation, in `backend/ws/engine/codex/accounts.ts`:
- Event `engine:codex-account-setup-start` spawns `codex login` (NOT a PTY — `Bun.spawn` with `stdout: 'pipe'`). The subprocess inherits the user's normal `~/.codex/` directory, exactly like the user running it from a terminal.
- A line-by-line stdout scanner detects `https://auth.openai.com/oauth/authorize?…` → emits `engine:codex-account-setup-url`.
- Frontend opens the URL via the existing system-tools `open-url` helper (or a window.open fallback in dev).
- A second scanner detects `Successfully logged in` → reads `~/.codex/auth.json` (which the CLI just wrote) → stores its content in `engine_accounts.credential` as `{kind:"chatgpt", authJson:<file content>}` → emits `engine:codex-account-setup-complete`.
- Failure paths: spawn error, stdout EOF before success, user-cancel — all map to `engine:codex-account-setup-error` with the captured CLI stderr.
- Headless fallback: `engine:codex-account-setup-device-auth-start` runs `codex login --device-auth`, captures the device code line, surfaces it to the UI.

The flow does not require a PTY because `codex login` does not prompt interactively after the URL is shown — it just blocks on the OAuth callback. This deviation from Claude's PTY flow needs to be documented in README §4 (see §8 of this plan).

> ⚠️ **Race during multi-account ChatGPT setup.** Because `codex login` writes to the shared `~/.codex/auth.json`, two simultaneous logins in the same OS user account would clobber each other. Mitigation: the WS handler serializes Codex login flows with a backend-wide mutex so only one `codex login` runs at a time. Document in README.

### 3.4 API key flow

Trivial: a form field in Settings → Engines → Codex → Add Account. Submit → store as `{kind:"api_key", apiKey}`. No CLI spawn needed. Mirrors Copilot exactly. Does not touch `~/.codex/auth.json`.

### 3.5 Per-stream account override

Same shape as Copilot (README §9.9). Tracking field: `currentAccountId`. When `streamQuery.accountId` differs from the running engine's `currentAccountId`:
1. `dispose()` the current `Codex` instance.
2. Apply the new account's auth (`~/.codex/auth.json` swap for ChatGPT; new `apiKey` for API key mode).
3. Re-init `Codex` for the next turn.

`dispose()` resets `currentAccountId` to `null` (README §9.11).

---

## 4. Codex adapter implementation (Stage C)

This stage follows the Stage 1–9 checklist in `backend/engine/README.md` §8 with the following Codex-specific notes. **Do not duplicate the README; only the deltas and decisions are listed here.**

### 4.1 File layout under `backend/engine/adapters/codex/`

```
index.ts              ← re-exports CodexEngine
stream.ts             ← class CodexEngine implements AIEngine
message-converter.ts  ← ThreadEvent / ThreadItem → EngineOutput
auth.ts               ← parse engine_accounts.credential JSON + auth.json swap
session-fork.ts       ← fork-by-copy of ~/.codex/sessions/<id>/ (mirror copilot/session-fork.ts)
error-handler.ts      ← CLI error message → user-facing string
```

No `server.ts` (SDK manages the subprocess lifecycle per turn) and no `config.ts` (single static OpenAI provider). No `environment.ts` either — we no longer override `env` aggressively, since the shared `~/.codex/` model means we want Codex to inherit the user's environment normally.

### 4.2 `streamQuery` event mapping

Codex SDK events (`ThreadEvent`) map to `EngineOutput` as follows. Items not listed are silently dropped (with a debug log).

| Codex event | EngineOutput emission |
|---|---|
| `thread.started` | Capture `thread_id` into stream state — used as Clopen's resumeable session id. Emit `SystemInitEvent` with `model`, `tools: []`, `mcpServers: ['clopen-mcp']`. |
| `turn.started` | `StreamEvent { event: 'start' }` |
| `item.started` (`reasoning`) | `StreamLifecycleEvent { reasoning: true, event: 'start' }` |
| `item.updated` (`reasoning`) | `TextDeltaEvent { reasoning: true, delta: <diff> }`. Codex sends full text on each update — diff against previously sent prefix. |
| `item.completed` (`reasoning`) | `StreamLifecycleEvent { reasoning: true, event: 'stop' }` |
| `item.completed` (`agent_message`) | Buffer until `turn.completed` carries usage (same pattern as Copilot, README §9.4) — then flush as `AssistantMessage`. |
| `item.completed` (`command_execution`) | Split per README §9.3: emit one `AssistantMessage` carrying a single `tool_use` block, canonical name `Bash`, input `{ command }`. Then emit a synthetic `UserMessage` with `tool_result` block — `parent.toolUseId: null` (README §9.5 sharp edge). |
| `item.completed` (`file_change`) | One Codex item can list N file changes. Per README §9.3, split into N assistant messages. Map per change `kind`: `add` → canonical `Write`; `update` → canonical `Edit`; `delete` → canonical `Bash` with synthesized `rm <path>` (no Clopen UI for delete). Document this mapping in `message-converter.ts`. |
| `item.completed` (`mcp_tool_call`) | `AssistantMessage` with canonical `mcp__<server>__<tool>`, then synthetic `UserMessage` with `tool_result`. The `result.content` already matches MCP `ContentBlock[]`. The `ask-user-question` tool falls into this branch but is also surfaced live via `chat:partial` (see §2.2). |
| `item.completed` (`web_search`) | `AssistantMessage` with canonical `WebSearch`, input `{ query }`. |
| `item.updated` / `item.completed` (`todo_list`) | `AssistantMessage` with canonical `TodoWrite`, input `{ todos: items }`. |
| `item.completed` (`error`) | Emit `chat:notification`-style message via the stream-manager's existing path (do not throw — a non-fatal item-level error). |
| `turn.completed` | Flush buffered assistant messages, attaching the turn's `usage` to the last one. Then emit `ResultEvent` with aggregated tokens (input/cached/output/reasoning). |
| `turn.failed` | Throw via `error-handler.ts::handleStreamError(event.error)` — stream-manager turns it into `chat:stream-finished` with error metadata. |
| `error` (top-level fatal) | Same — throw via `handleStreamError`. |

Reasoning streaming: Codex sends `item.started` once and then `item.updated` with cumulative text. Track the previously emitted prefix in `state` and emit only the suffix as a `TextDeltaEvent`.

Tool-name and tool-input canonicalization both required (README §9.1). Build the `CODEX_TOOL_NAME_MAP` and `normalizeCodexToolInput` dispatchers up-front. The mapping for `mcp__ask-user-question__ask_user_question` → `'AskUserQuestion'` lives in `shared/types/unified/tool.ts` (§2.2 above), not in the adapter.

Harness-tool filter (README §9.2): the SDK enumerates only the items above. There are no internal tools to filter. Skip the `IGNORED_*` pattern unless it shows up in QA.

### 4.3 Cancel ordering

The SDK accepts `signal` in `TurnOptions` and propagates it into the spawned `codex exec`. Cancel order (README §9.10 prefix):
1. Abort the local controller — `for await` loop exits deterministically.
2. SDK abort propagates SIGTERM to the subprocess — no separate RPC.

No 5-second RPC timeout race needed.

### 4.4 Fork session

Codex thread state lives at `~/.codex/sessions/<thread_id>/` (the user's shared dir). The directory contents (rollout files, jsonl events, etc.) are not documented in the SDK — verify by inspecting the live path during Stage C QA. The mechanism mirrors `copilot/session-fork.ts`:

- `forkCodexSessionState(srcId, forkId)` copies `~/.codex/sessions/<srcId>/` → `~/.codex/sessions/<forkId>/`.
- Patch the embedded thread id inside any file that records it (filenames or jsonl `session.start.thread_id`-like fields) — exact substitutions to be confirmed during QA.
- Per-stream override: when `EngineQueryOptions.resume` is set, fork unconditionally (README §9.10 sharp edge — do NOT gate on `forkSession`), then call `codex.resumeThread(forkId, threadOptions)`.

Delete `session-fork.ts` and switch to a native SDK fork as soon as `@openai/codex-sdk` exposes one. Pin a `// TODO` comment to the SDK source so the migration is mechanical.

> Cross-account-resume note: because `~/.codex/sessions/` is shared, a session forked under account A will be readable by account B if accounts swap. That is identical to running the Codex CLI manually as the same OS user with two ChatGPT accounts; we don't add isolation on top.

### 4.5 Connecting to MCP

```ts
import { getCodexMcpConfig } from '../../../mcp/config';

new Codex({
  apiKey: account.kind === 'api_key' ? account.apiKey : undefined,
  config: {
    show_raw_agent_reasoning: true,
    sandbox_workspace_write: { network_access: true },
    mcp_servers: getCodexMcpConfig(),
  },
});
```

`getCodexMcpConfig()` returns `{ 'clopen-mcp': { url: 'http://localhost:<port>/mcp' } }`. Codex's CLI then connects to the existing remote MCP and sees every enabled server (`browser-automation`, `weather-service`, `ask-user-question`, plus anything we add later) as `clopen-mcp_<tool>`. The `resolveOpenCodeToolName()` helper in `backend/mcp/config.ts` already strips the `clopen-mcp_` prefix and reverse-maps to `mcp__<server>__<tool>` — Codex's `mcp_tool_call` items also need to go through the same resolver before tool-name canonicalization. (Existing function, no new code; just call it from `message-converter.ts`.)

No bearer token, no env injection, no per-stream URLs. Same surface OpenCode uses today.

### 4.6 ThreadOptions per stream

```ts
const thread = codex.startThread({
  model: modelId,                      // e.g. 'gpt-5.4'
  workingDirectory: resolvedProjectPath,
  skipGitRepoCheck: true,
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  modelReasoningEffort: 'medium',
  networkAccessEnabled: true,
  webSearchMode: 'cached',
});
const { events } = await thread.runStreamed(input, { signal: abortController.signal });
```

For `resume`, swap `startThread` for `resumeThread(forkId)` (forkId from §4.4).

Input mapping: `EngineQueryOptions.prompt.content` blocks → Codex `Input`. Text blocks concatenate; image blocks become `{ type: 'local_image', path }` after writing the image bytes to a temp file (since the SDK's `local_image` accepts only paths). Document blocks (PDFs) — Codex SDK has no document input; convert to text or skip with a debug warning.

### 4.7 `getAvailableModels`

Static — return the list from `shared/constants/engines.ts::CODEX_MODELS`. Do NOT spawn the CLI. See §6 for the catalog.

### 4.8 AskUserQuestion resolution path

No `resolveUserAnswer` method on `CodexEngine`. The flow is fully decoupled:

1. Codex calls the MCP tool `mcp__ask-user-question__ask_user_question`.
2. The MCP server's tool handler emits `chat:partial` (UI shows the bubble) and awaits a Promise.
3. User clicks an answer → frontend sends `chat:resolveUserAnswer { streamId, questionId, answer }`.
4. WS handler calls into the MCP server's pending registry directly (`askUserQuestionResolve(streamId, questionId, answer)` exported from the server module).
5. Promise resolves → MCP tool result returned to Codex → Codex turn continues.

Stream cancel: the abort signal triggers `askUserQuestionAbortAll(streamId)` which rejects every pending promise for that stream with a structured tool error.

Same module is reachable from any engine that wants to use it. If we ever migrate Claude's built-in AskUserQuestion to MCP, no additional plumbing is needed.

---

## 5. Database, WebSocket, system-tools (Stage D — small)

Follows README §3 / §4 / §7 verbatim. Codex-specific items:

- **Migration** to seed the OpenAI provider:
  ```sql
  INSERT INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
  VALUES ('codex', 'openai', 'OpenAI', NULL, NULL, '{}', 1);
  ```

- **WebSocket router** `backend/ws/engine/codex/`:
  - `status.ts` — `engine:codex-status`: detect `codex` binary + version, report active account, `backendOS`.
  - `accounts.ts` — list / switch / delete / rename + the dual setup flow (API key submit, ChatGPT browser login, ChatGPT device-auth login). Setup events follow Claude's naming convention (`engine:codex-account-setup-start|url|complete|error|cancel|stream-data`).
    - Switch handler writes `~/.codex/auth.json` from the chosen account's stored blob (ChatGPT mode) before returning.
    - Login handler captures the URL, then on success snapshots `~/.codex/auth.json` into the new row.
    - Post-stream hook (in `stream-manager.ts` or the engine's `dispose()`) snapshots `~/.codex/auth.json` back to the active account's row to persist token refreshes.
  - `index.ts` — merge.
  - Add `'codex'` to the typebox literals in `backend/ws/chat/stream.ts` and `backend/ws/settings/crud.ts` (`models:list`).

- **`chat:resolveUserAnswer` WS handler** (§2.2 step 3) — added once, used by every engine with an MCP-based AskUserQuestion. Lives in `backend/ws/chat/`.

- **System Tools recipe** for `codex` in `backend/engine/install-recipes.ts`:
  - Recipe: `bun add -g @openai/codex` on every platform (macOS / Linux / Windows). Manual fallback instructions per OS.
  - `autoInstallable: true` whenever `bun` is on PATH; otherwise `unavailableReason: "Bun is required to install Codex CLI"` and require the user to install Bun first via the existing Bun recipe.
  - Add `'codex'` to `ToolId` and to `TOOL_UNION` in the system-tools router.
  - Add `<ToolInstallCard tool="codex" ... />` to `SystemToolsSettings.svelte`.

---

## 6. Static models catalog (Stage E — tiny)

In `shared/constants/engines.ts`, add `CODEX_MODELS: EngineModel[]` and an `ENGINES[]` entry. Set `engine.type = 'codex'` and `engine.provider = 'openai'`.

Catalog (sourced from https://developers.openai.com/codex/models.md, pruned for what Codex SDK actually accepts):

| id | display name | API key? | ChatGPT? | reasoning | input modalities |
|---|---|---|---|---|---|
| `gpt-5.4`         | GPT-5.4               | ✓ | ✓ | ✓ | text, image |
| `gpt-5.4-mini`    | GPT-5.4 mini          | ✓ | ✓ | ✓ | text, image |
| `gpt-5.3-codex`   | GPT-5.3 Codex         | ✓ | ✓ | ✓ | text, image |
| `gpt-5.2`         | GPT-5.2 (alternative) | ✓ | ✓ | ✓ | text, image |
| `gpt-5.5`         | GPT-5.5 (ChatGPT only)| ✗ | ✓ | ✓ | text, image |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark (ChatGPT Pro only) | ✗ | ✓ | — | text |

Add `requiresAuthMode?: 'chatgpt' | 'api_key'` to `EngineModel.capabilities` so `EngineModelPicker` can disable models incompatible with the chosen account's `kind`. The picker filters models based on the active Codex account's `kind` parsed from `credential`.

Default Codex model: `gpt-5.4` (works for both auth modes).

---

## 7. Network access default — rationale

User asked for guidance. Recommendation: **enable** (`network_access = true`).

- Claude in Clopen runs with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` (`claude/stream.ts:115-116`). OpenCode runs with the configured provider keys and no sandbox. Copilot does not sandbox.
- Setting Codex to no-network would be the only sandboxed engine, which is inconsistent — and because `approvalPolicy: 'never'`, blocked network calls would fail silently rather than prompting (Codex docs §"Run without approval prompts"). Failing silently is worse UX than allowing.
- Codex's blast radius is bounded to `workspace-write` and protected paths (`.git`, `.codex`, `.agents` — see Codex docs §"Protected paths"), which is stricter than Claude's `bypassPermissions`. So enabling network keeps Codex AT LEAST as safe as Claude.
- We can still expose this as a `Settings → Engines → Codex` toggle later if a user wants caution. Out of scope for MVP.

---

## 8. Documentation updates to `backend/engine/README.md` (Stage F)

`README.md` describes Claude/OpenCode/Copilot. After Codex lands, edit the README to:

1. **§1 architecture map**: add Codex card (alongside Claude/OpenCode/Copilot). Mention that Codex uses the existing `backend/mcp/remote-server.ts` (no architectural diagram changes — same surface as OpenCode).
2. **§2.6 standard files**: clarify when `auth.ts` is needed (any adapter that has to materialize a credential blob to a known on-disk location; cite Codex's `~/.codex/auth.json` swap).
3. **§3 database**: extend §3.3 ("How an adapter reads them") with a Codex paragraph — mention the auth-blob → `~/.codex/auth.json` swap pattern and the post-stream snapshot to capture token refreshes.
4. **§4 WebSocket routes**: add §4.6 "Codex — `engine:codex-*`" mirroring §4.1 / §4.3 but documenting the dual setup flow (API key submit, ChatGPT browser login + device-code fallback) and the lack of PTY (no Claude-style state machine — line-scanner is enough).
5. **§5 frontend stores**: add a one-paragraph note that Codex uses the single-account-list shape (like Claude/Copilot) but reflects the auth-mode (`api_key`/`chatgpt`) in the account list so the model picker can filter.
6. **§6.2 EngineModelPicker**: add Codex to the `accountsForEngine` / `accountPickerLabel` / `showAccountPicker` branches AND document the new `requiresAuthMode` model filtering.
7. **§7 install recipes**: add a Codex bullet pointing at `bun add -g @openai/codex`.
8. **§8 end-to-end checklist**: no edits — checklist is generic.
9. **§9 lessons learned**:
   - Add §9.12 "Auth-blob swap into shared CLI dotfile". Pattern: store the CLI's auth file content in DB, write it back at switch time; snapshot back after each stream to preserve auto-refresh. Trade-off: only one active account at a time; concurrent streams from different accounts will race.
   - Add §9.13 "Engine-agnostic AskUserQuestion via MCP server". Pattern: when an engine SDK has no callback hook, expose AskUserQuestion as an MCP tool whose handler blocks on a Promise resolved by the chat WS router. The flow is engine-agnostic and reusable.
   - **Do NOT** add a "MCP HTTP bridge" section — that infrastructure already exists and is documented in `backend/mcp/README.md`.
10. **§10 quick reference table**: add Codex rows for "auth materialization" and "static model catalog with auth-mode filtering".

`backend/mcp/README.md` also needs minor edits (Stage F):
- Add a sentence in the "Engines that consume Clopen MCP" section noting that Codex uses `getCodexMcpConfig()` to point at the same `/mcp` endpoint as OpenCode.
- Document the new `ask-user-question` server in the registry list.

---

## 9. Execution order with stop-points

Per CLAUDE.md "STOP after each stage for review", the sequencing is:

| Stage | Title | Output | Stop / review |
|---|---|---|---|
| **A** | `ask-user-question` MCP server + `getCodexMcpConfig()` + `chat:resolveUserAnswer` WS handler | New code under `backend/mcp/servers/ask-user-question/` and one helper in `backend/mcp/config.ts`. `bun run check` + `bun run lint` pass. Manual smoke: hit `/mcp` with curl and confirm the tool appears in `tools/list`. | YES — review the MCP wiring before consumers exist. |
| **B** | Codex auth — DB seed + setup flow + auth.json swap | Migration seeded. WS router for codex accounts done. Both auth flows produce a working `engine_accounts.credential` row. ChatGPT account swap into `~/.codex/auth.json` verified. Login serialization mutex in place. No streaming yet. | YES — verify both auth modes end-to-end before wiring chat. |
| **C** | Codex adapter (`backend/engine/adapters/codex/`) + `chat:stream` integration | Single chat turn streams end-to-end. Tool calls render. Reasoning streams. Usage attaches. Cancel works. Fork-on-resume verified. AskUserQuestion bubble appears and resolves. | YES — UI smoke test against the §8 manual QA checklist in README. |
| **D** | Frontend Settings → Engines panel + EngineModelPicker wiring | Codex card visible. Account add/switch/delete/rename works. Model picker disables ChatGPT-only models when API-key account is active. | YES. |
| **E** | System Tools recipe + `engine:codex-status` install detection | Install button completes. Status badge live. | YES. |
| **F** | Documentation updates to `backend/engine/README.md` and `backend/mcp/README.md` per §8 above | READMEs reflect Codex. | Final review + branch + commit suggestions. |

Each stage MUST end with `bun run check && bun run lint` clean.

Branch suggestion (per CLAUDE.md commit conventions): `feat/codex-engine`. Final commit message: `feat(codex): integrate openai codex engine adapter`. Intermediate per-stage commits use the same scope, e.g. `feat(codex): add ask-user-question mcp server`, `feat(codex): add dual auth flow`, etc.

---

## 10. Known risks & follow-ups (not in scope)

| Risk | Mitigation in plan | Follow-up |
|---|---|---|
| Codex SDK adds a native `forkSession` API → our copy-fork becomes dead code | Pin a `// TODO` in `session-fork.ts` referencing the SDK source | Delete `session-fork.ts` and use SDK fork |
| Two Codex streams from different ChatGPT accounts overlap → second one's auth.json overwrites the first mid-flight | Document as known limitation; UI surfaces only one active account at a time | Future: per-stream `CODEX_HOME` (rejected for MVP) or a serialization queue per engine |
| Two simultaneous `codex login` runs would clobber `~/.codex/auth.json` | Backend-wide mutex serializes Codex login flows in the WS handler | None |
| ChatGPT token refreshed during a stream isn't persisted to DB | Post-stream snapshot of `~/.codex/auth.json` writes back to active account's `credential` | Background watcher on the file |
| `gpt-5.5` / spark not available with API-key auth | Model picker disables them when active account is `api_key` mode | Surface a "switch to ChatGPT login" hint in the picker |
| `file_change` items in Codex bundle multiple files per item; mapping to single-file UI tools may misrepresent diffs | Split per README §9.3 and document mapping (`add`→Write, `update`→Edit, `delete`→Bash `rm`) in `message-converter.ts` | Frontend tool variant for Codex multi-file change blocks |
| Codex CLI install via `bun add -g` requires Bun on PATH | Recipe declares `bun` as a missing-prereq; user installs Bun first via existing recipe | None |
| User's existing global `~/.codex/config.toml` gets overridden by SDK `--config` flags | `--config` is additive per Codex docs; user values not touched by us are preserved | Document in README §9.12 |

---

End of plan. Awaiting confirmation before starting Stage A.
