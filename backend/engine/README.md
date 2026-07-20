# `backend/engine/` — End-to-End Adapter Guide

This folder is the **boundary** between Clopen and the AI SDKs that drive
streaming chat. Today there are three adapters: **`claude`**
(`@anthropic-ai/claude-agent-sdk`), **`opencode`** (`@opencode-ai/sdk`), and
**`copilot`** (`@github/copilot-sdk`). Every adapter follows the same shape so
that the rest of the system outside this folder — `stream-manager`, MCP, DB,
WebSocket, frontend chat, settings UI — stays **agnostic** to the underlying
SDK.

This guide is split into focused documents — start here for the architecture
map, then jump to the area you need.

## Contents

1. [Architecture map](#1-architecture-map) — the layers and the two design pitfalls to read before proposing new infrastructure (below).
2. [Adapter contract](./docs/adapter-contract.md) — the `AIEngine` interface, `EngineOutput`, `EngineQueryOptions`, the standard adapter file taxonomy, and what an adapter must NOT do.
3. [Database](./docs/database.md) — `engine_providers` + `engine_accounts`, `engineQueries`, and how each adapter reads credentials.
4. [WebSocket routes](./docs/websocket-routes.md) — `engine:*`, `system-tools:*`, `models:list`, `chat:stream`, and the Restart-Server pattern.
5. [Frontend & chat integration](./docs/frontend-and-chat.md) — Settings → Engines / System Tools, the model picker, the send path, reasoning/attachments/AskUserQuestion.
6. [System Tools](./docs/system-tools.md) — registering a binary in `install-recipes.ts` + the install runner.
7. [Artifacts & Access](./docs/artifacts.md) — the extension layer (Skills, Commands, Subagents, Instructions, Permissions, Profiles, MCP), the capability matrix, and the `artifact-sync.ts` seam adapters call at stream start.
8. [Adding a new engine](./docs/adding-an-engine.md) — the end-to-end, stage-by-stage checklist.
9. [Lessons learned](./docs/lessons-learned.md) — §10 pitfalls (tool name/input canonicalisation, fork session, MCP reuse, auth-blob swap, sub-agent routing, OpenCode v1/v2, structured output, …).
10. [Quick reference](./docs/quick-reference.md) — "I need X → look in file Y" table.

---

## 1. Architecture map

```
┌──────────────────── FRONTEND (Svelte 5 + runes) ─────────────────────┐
│                                                                       │
│  Settings → Engines           Settings → System Tools  Chat Input     │
│  ─────────────────────        ──────────────────────  ──────────────  │
│  AIEnginesSettings+panels/    SystemToolsSettings…    EngineModel…    │
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
│  │    models.ts               static array OR dynamic fetcher       │ │
│  │    error-handler.ts        SDK error → user-facing string        │ │
│  │    credential.ts?          credential parsing / auth-blob swap   │ │
│  │    environment.ts?         env-var / dotfile setup               │ │
│  │    server.ts?              subprocess + client (opencode only)   │ │
│  │    config.ts?              runtime config builder (opencode only)│ │
│  │    presets.ts?             provider/region preset catalog        │ │
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

> ⚠️ **Before you propose new infrastructure, read this.**
> Two design pitfalls have repeatedly tripped people adding new adapters.
> Before sketching architecture, double-check:
>
> 1. **MCP over HTTP already exists.** `backend/mcp/internal/remote-server.ts` mounts
>    every `defineServer()`-registered MCP server as a Streamable HTTP
>    endpoint at `http://localhost:<port>/mcp`. OpenCode consumes it via
>    `getOpenCodeMcpConfig()`. Any engine whose CLI/SDK accepts a
>    `streamable-http` MCP URL (Codex, future engines) reuses **the same
>    URL** by adding a sibling `getXxxMcpConfig()` helper in
>    `backend/mcp/internal/config.ts`. Do **NOT** propose a "new MCP bridge",
>    "per-engine MCP server", or "per-stream MCP path". See §10.12.
> 2. **Engine home dirs are isolated per-engine (Clopen vs. global), but
>    multi-account stays DB-swap.** Two different axes — don't conflate them:
>    - **Clopen vs. the user's global CLI usage:** every engine's home/config
>      is redirected to `{clopenDir}/engine/{engine}/user/` via that engine's env
>      var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` via
>      `baseDirectory`, `QWEN_RUNTIME_DIR`, `XDG_*` for OpenCode) so Clopen
>      never touches `~/.codex`, `~/.copilot`, … See §10.19.
>    - **Multiple accounts *within* Clopen:** still the auth-blob swap — one
>      shared dotfile inside that isolated home, snapshotted to/from the DB on
>      login/switch. Do **NOT** propose **per-account** home dirs
>      (`CODEX_HOME=/foo/account-1/`); that splits session-state, breaks
>      fork-by-copy, and loses token-refresh persistence. See §10.13.

---

The full guide lives under [`docs/`](./docs). When in doubt: **mirror** the
existing adapters and let `EngineOutput` remain the only contract that crosses
the adapter boundary.
