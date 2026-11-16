# Technical Decisions

---

## Architecture

### 1. Bun.js as Runtime

**Decision:** Bun.js instead of Node.js
**Rationale:** Better performance for CLI spawning and WebSocket connections, native TypeScript support, faster startup and package installation, built-in tooling.
**Trade-offs:** Less mature ecosystem, potential npm package compatibility issues.

---

### 2. Separate Frontend/Backend with WebSocket

**Decision:** Separate frontend and backend communicating via WebSocket
**Rationale:** Clean separation of concerns — Svelte 5 + Vite for UI, Elysia for backend logic. WebSocket provides real-time bidirectional communication over a single persistent connection on port 9141.
**Trade-offs:** More complex setup than monolithic architecture, requires connection state management.

---

### 3. Native WebSocket over SSE

**Decision:** Native WebSocket instead of Server-Sent Events
**Rationale:** Bidirectional communication required for chat, terminal input, file operations, and browser preview interaction. Room-based architecture enables project isolation and keeps every device in sync.
**Trade-offs:** More complex state management, reconnection logic required.

---

### 4. SQLite for Local Storage

**Decision:** SQLite instead of PostgreSQL or other databases
**Rationale:** No separate server needed, file-based storage ideal for local app, easy backup and portability, good performance for a single owner's workload.
**Trade-offs:** Limited concurrent writes, no built-in replication.

---

## Frameworks

### 5. Svelte 5 with Runes

**Decision:** Svelte 5 with runes system instead of React/Vue
**Rationale:** More explicit reactivity, better TypeScript integration, improved performance, smaller bundle size.
**Trade-offs:** Smaller ecosystem, breaking changes from Svelte 4.

---

### 6. Elysia as Backend Framework

**Decision:** Elysia instead of Express or Fastify
**Rationale:** Built specifically for Bun, native TypeScript with type inference, built-in WebSocket support, excellent performance.
**Trade-offs:** Newer framework with smaller ecosystem.

---

### 7. Tailwind CSS v4

**Decision:** Tailwind CSS v4 with CSS-first configuration
**Rationale:** CSS-first config eliminates JS config files, native CSS variables for theming, faster incremental builds, modern CSS features.
**Trade-offs:** Requires modern browsers, breaking changes from v3.

---

## AI Engine Integration

### 8. Engine-Agnostic Adapter Pattern

**Decision:** Adapter pattern for AI engines, all normalizing output to a unified message format (`shared/types/unified`). Currently five engines ship in-tree under `backend/engine/adapters/`: `claude` (Claude Code), `opencode` (OpenCode), `codex` (OpenAI Codex), `copilot` (GitHub Copilot), and `qwen` (Qwen Code).
**Rationale:** Frontend, stream manager, and checkpoint system remain engine-agnostic — they only consume `EngineOutput` events from the unified type system. Each engine evolves independently behind the `AIEngine` interface (`streamQuery`, `cancel`, `interrupt`, `dispose`, model list, optional `resolveUserAnswer` for AskUserQuestion). Per-project engine registries isolate state so cross-project sessions never leak. Adding a new engine is a self-contained change: drop a folder under `backend/engine/adapters/<name>/` implementing the contract — no surgery in the frontend, stream manager, or DB schema.
**Trade-offs:** Added abstraction layer; OpenCode requires a background server process; some engines (e.g. Codex today) lack SDK hooks for AskUserQuestion and must surface that gap behind the same interface.

---

### 9. Claude Agent SDK for Claude Engine

**Decision:** Claude Agent SDK inside the Claude Code engine adapter
**Rationale:** Official Anthropic SDK with built-in streaming, tool use handling, session management, and type-safe TypeScript API.
**Trade-offs:** Dependency on Anthropic SDK updates.

---

### 10. bun-pty for Terminal (Interactive PTY)

**Decision:** bun-pty instead of node-pty for interactive PTY sessions (terminal emulator, Claude auth flow)
**Rationale:** Native Bun implementation, full PTY emulation, cross-platform (Windows/macOS/Linux), maintained for Bun ecosystem.
**Note:** Bun now has built-in PTY via `Bun.spawn({ terminal })`, but it is POSIX-only (no Windows). Since Clopen must support Windows, bun-pty remains the correct choice for interactive PTY. Bun.spawn (pipe-based) is used for non-interactive subprocesses.
**Trade-offs:** Smaller community than node-pty, extra dependency.

---

## Features

### 11. Built-in Git Management

**Decision:** Full source control using native git CLI subprocess instead of a library
**Rationale:** Direct git calls are always in sync with actual repo state, no extra dependencies, supports the full range of operations needed.
**Trade-offs:** Requires git installed on host, porcelain output parsing must stay in sync with git versions.

---

### 12. Multi-Account Claude Code

**Decision:** Store multiple Claude Code OAuth tokens in SQLite, support per-session account switching
**Rationale:** Developers need multiple accounts (personal/work/team). Tokens injected via `CLAUDE_CODE_OAUTH_TOKEN` env override, isolated under `{clopenDir}/engine/claude/user/` without touching system-level Claude config. `clopenDir` is `~/.clopen-dev` in development, `~/.clopen` in production.
**Trade-offs:** OAuth tokens stored in plaintext locally, no automated login flow yet.

---

### 13. OpenCode via SDK Client + Bun.spawn Server

**Decision:** Spawn `opencode serve` via Bun.spawn, connect via `createOpencodeClient` from `@opencode-ai/sdk`
**Rationale:** The SDK's `createOpencode` uses `node:child_process.spawn` internally, which resolves binaries differently than `Bun.spawn` — causing ENOENT on devices where `opencode` is installed in non-standard PATH locations (e.g. `~/.local/bin`, `~/go/bin`). By spawning with Bun.spawn and resolving the binary via `Bun.which()` (absolute path), binary resolution works even when explicit `env` is passed to `Bun.spawn`. The SDK's client (`createOpencodeClient`) is still used for HTTP communication.
**Trade-offs:** Must maintain stdout parsing for server URL (`"opencode server listening on <url>"`), background server process adds memory overhead.

---

### 14. Git-Like Commit Graph for Checkpoints

**Decision:** Git-like commit graph (parent-child messages, HEAD pointer, branches table) instead of soft-delete
**Rationale:** Parent-child relationships are more reliable than timestamp ordering. HEAD pointer provides clear current position. Graph structure handles branching naturally with the same mental model as git.
**Trade-offs:** More complex queries (graph traversal vs simple WHERE), higher upfront design cost.

---

### 15. File Snapshot System

**Decision:** Content-addressable blob storage on filesystem (`{clopenDir}/snapshots/`) with lightweight DB metadata, not storing file content in the database
**Rationale:** Git-inspired design — blobs stored as gzip-compressed files keyed by SHA-256 hash with 2-char prefix subdirectories, identical content deduplicated automatically. Tree files map filepath → blob hash per snapshot. DB stores only metadata and delta stats (no file content). mtime cache avoids re-reading unchanged files. Supports binary files safely via Buffer throughout.
**Trade-offs:** Increased filesystem usage over time, legacy two-format support adds restoration complexity.

---

## Browser Preview

### 16. Puppeteer for Browser Automation

**Decision:** Puppeteer instead of Playwright or Selenium
**Rationale:** Excellent Chrome DevTools Protocol (CDP) integration, rich control API, native screenshot and video capture, official Chrome/Chromium automation tool.
**Trade-offs:** Chrome/Chromium only, higher resource usage than iframe.

---

### 17. WebCodecs Video Encoding

**Decision:** WebCodecs-based video encoding in Chromium instead of JPEG sequence streaming
**Rationale:** JPEG at 24fps uses ~720KB/s. WebCodecs offloads encoding to Chromium (hardware-accelerated), server only forwards binary chunks — 80-90% bandwidth reduction.
**Trade-offs:** Modern browsers only (Chrome 94+, Safari 16.4+, Firefox 130+), no Firefox Android.

---

### 18. Modern Browsers Only

**Decision:** No backward compatibility, target modern browsers only
**Rationale:** Clean codebase, modern APIs without polyfills, target audience uses modern development tools.
**Trade-offs:** No support for older browsers, Firefox Android unsupported.

---

## Authentication & Devices

### 19. Single Owner, Many Devices (No-Auth or With Login)

**Decision:** Clopen has exactly one account — the owner — signed in on any number of devices. Authentication is either No Login or With Login (token-based), configurable during the setup wizard and togglable in Settings → Sign-in & Devices. Multi-user collaboration (admin/member roles, invites, per-project membership, per-user scoping of connections, git identities and Home) was removed in migration `086_single_owner`.
**Rationale:** Clopen is full control of one machine, so splitting it between people made every feature carry a second access model: each change had to answer "who may see or do this", that logic was spread across nearly every surface, it was the source of many bugs, and the feature was rarely used. Remote Access covers the real need — reaching your own Clopen from a phone or another computer — without any of it. The system stores `authMode` in `system:settings` (`'none'` or `'required'`). In No Login mode the owner is auto-created and all WS routes bypass authentication; in With Login every route except sign-in needs an authenticated connection. Token types: session (`clp_ses_*`, 30-day, auto-reconnect), PAT (`clp_pat_*`, permanent), device code (`clp_dev_*`, single-use, 5-minute pairing link), file share (`clp_fsh_*`). Rate limiting and CLI `clopen reset-pat` recovery apply in With Login mode. Migration 086 keeps the oldest admin as the owner and deletes every other account together with its sessions, device codes, paired chats, Home, saved connections and git identities, so no credential of a former member can sign in with full control.
**Trade-offs:** No Login mode has no access control, so the owner must be aware when exposing it via a tunnel. Data that belonged only to removed accounts is gone after upgrading; shared project history is kept.

---

### 20. Live Status Across Devices

**Decision:** WebSocket-based stream status per project (`projects:presence-updated`), broadcast to every device
**Rationale:** Every device shows the same busy / waiting-for-input indicators, even for projects it is not currently viewing.
**Trade-offs:** Status is in memory and rebuilt from running streams after a restart.

---

## Infrastructure

### 21. Cloudflare Tunnel Built-In

**Decision:** Built-in Cloudflare Tunnel support; the `cloudflared` binary is installed on demand from **Settings → Stack** (not auto-downloaded on first tunnel use).
**Rationale:** One-click public URL with HTTPS, no port forwarding needed, works across networks and firewalls, QR code for mobile access. Routing the binary install through Stack gives explicit, audit-able control and mirrors how Git/Claude Code/OpenCode/Chrome are managed.
**Trade-offs:** Requires internet access, dependent on Cloudflare availability. Public Tunnel now fails with a "install cloudflared" prompt until cloudflared is installed once.

---

### 22. Multi-Project Support

**Decision:** Multiple independent projects with separate contexts
**Rationale:** Users work on multiple projects simultaneously, each with its own chat history, settings, and WebSocket room.
**Trade-offs:** More complex state management per project.

---

## Tooling

### 23. Custom Logger (`debug` module)

**Decision:** Custom `debug` module to replace console.*, with label-based filtering
**Rationale:** Structured logging with 22 label categories, runtime filtering, production-ready without code changes. Named `debug` to avoid `$` prefix conflict in Svelte.
**Trade-offs:** Team must learn the module API.

---

### 24. Port 9141, No Fallback

**Decision:** Fixed port 9141 with hard failure if occupied
**Rationale:** Predictable, consistent port for all users and documentation. No complex discovery logic.
**Trade-offs:** Users must resolve port conflicts manually.

---

### 25. ESLint Only, No Prettier

**Decision:** Remove Prettier, use ESLint + svelte-check only
**Rationale:** Prettier conflicts with ESLint and svelte-check on formatting. Two-tool strategy: `bun run check` for types/Svelte compiler, `bun run lint` for bug patterns. Disabled in `.vscode/settings.json` to prevent accidental reformats.
**Trade-offs:** Formatting not enforced by tooling.

---

### 26. Modular Preview Folder Structure

**Decision:** Platform-based folder structure (`browser/`, `shared/`) for the preview system
**Rationale:** Isolates platform-specific code, easy to add Android/iOS/Desktop preview in the future.
**Trade-offs:** More folders for a currently single-platform feature.

---

### 27. Data Directory Separation by Environment

**Decision:** Development instances use `~/.clopen-dev`, production uses `~/.clopen`, resolved via `getClopenDir()` in `backend/utils/paths.ts`
**Rationale:** Clopen can be used to develop itself. Without separation, dev and production instances on the same machine share the same SQLite database, blob store, and Claude config — causing data corruption and confusion.
**Trade-offs:** None.

---

### 28. Path Normalization for MCP Cross-Platform

**Decision:** Generate multiple path variations for Claude Code config lookup
**Rationale:** Claude Code stores configs with different formats (Windows `C:\`, Unix `/c/`). Case-insensitive matching ensures MCP servers are found regardless of path format.
**Trade-offs:** Slightly more complex lookup logic.

---

### 29. Multi-Step Setup Wizard

**Decision:** Replace single-page setup with a multi-step wizard (auth mode → account → AI engines → preferences)
**Rationale:** First-time setup involves multiple concerns — authentication strategy, account creation, engine availability, and appearance preferences. A step-by-step wizard reduces cognitive load and lets users skip optional steps (engines, preferences) while ensuring critical decisions (auth mode) are made upfront. The stepper UI shows progress and allows navigation back to completed steps.
**Trade-offs:** More complex setup component, but each step is self-contained and reuses existing components/logic.

---

### 30. Subprocess Spawn Strategy

**Decision:** Use `Bun.spawn` for all non-interactive subprocesses, `bun-pty` for interactive PTY sessions
**Rationale:** Third-party SDKs that use `node:child_process.spawn` resolve binaries differently than `Bun.spawn`, causing ENOENT on some devices. All Clopen-owned subprocess spawning uses `Bun.spawn` for consistent binary resolution. Interactive sessions (terminal emulator, Claude auth) use `bun-pty` for full PTY emulation including Windows support.
**Trade-offs:** Must avoid relying on third-party SDK spawn functions for CLI binaries.

---

### 31. PATH Enrichment

**Decision:** Before binary detection, enrich `process.env.PATH` with a deterministic list of known install directories (clopen-managed `~/.clopen/bin`, install-script targets like `~/.local/bin` and `~/.opencode/bin`, user runtimes `~/.bun/bin` / `~/.deno/bin` / `~/.cargo/bin` / `~/.volta/bin` / `~/.yarn/bin` / `go/bin`, system managers `/opt/homebrew/bin` / `/usr/local/bin` / `/home/linuxbrew/.linuxbrew/bin`, version managers nvm/fnm/asdf, and Windows equivalents for scoop shims / winget links / git cmd / npm). On Unix desktops, additionally harvest the user's login+interactive shell PATH as a secondary layer — hardened to skip invalid shells (including the literal string `"unknown"` returned by `userInfo()` on containers without `/etc/passwd` entries) and cached once per process. Implemented in `backend/utils/path-enrich.ts`.
**Rationale:** Clopen runs across wildly different environments — desktop GUI launches (macOS/Linux), terminal launches, systemd services, Docker/Railway containers, Windows. The previous approach (spawning the user shell) was only correct for one of these; in containers it always failed (`$SHELL` unset, `userInfo().shell === "unknown"`), producing spam warnings and a wasted 2s per status call. Known-dirs is deterministic, cross-platform, and covers both the Stack installer targets and the common locations users install CLIs themselves. Existing-dir checks happen every call so newly-installed tools appear without a restart.
**Trade-offs:** The known-dirs list must be maintained when new install locations enter common use. Users with truly custom PATH entries in rc files (not on the list) on non-desktop environments won't be discovered — acceptable because the shell-harvest fallback still covers that case on desktops where `$SHELL` is valid.

---

### 32. Stack Installer (Server-side)

**Decision:** **Settings → Stack** section installs Git, Claude Code, OpenCode, Codex, Copilot, Qwen Code, Chrome, and Cloudflared via a server-side recipe registry (`backend/engine/install-recipes.ts`, `ToolId = 'git' | 'claude' | 'opencode' | 'copilot' | 'codex' | 'qwen' | 'chrome' | 'cloudflared'`). Chrome uses `@puppeteer/browsers install chrome@stable` on macOS/Windows for a self-contained Chrome for Testing binary. On Linux x86_64 it installs Google Chrome directly from Google's own channels (`.deb` from `dl.google.com` via `apt-get install` on apt, and the `.rpm` URL via `dnf install` / `zypper install` on dnf/zypper) so system library dependencies (libatk, libnss3, …) auto-resolve via the distro package manager and Google's postinst registers an apt repo for future updates. Platforms without an official Google Chrome package (pacman, apk, Linux arm64) are marked non-auto-installable and surface manual instructions — clopen does not fall back to chromium so the runtime stays a single known build. Each install runs through `backend/engine/install-runner.ts`, which spawns the recipe via `Bun.spawn`, streams stdout/stderr line-by-line over WebSocket (`stack:install-stream`), buffers output in a bounded ring buffer (so late subscribers can catch up), and supports cancellation. Output renders client-side in xterm.js so ANSI escapes and `\r`-based progress bars display correctly. After a successful install, the runner re-enriches PATH so downstream code paths (e.g. `models:list` → `Bun.which('opencode')`) immediately see the new binary without a process restart.
**Rationale:** Dropping into a terminal to install dependencies is friction, especially for someone running clopen as a managed workspace. Recipes are server-only (clients can only pick a tool id) so the client cannot supply arbitrary commands. Privilege detection (`backend/utils/privilege.ts`) determines whether sudo/admin is available and selects the right recipe variant per platform; tools that require interactive elevation (e.g. apt-get with sudo on a non-elevated server) are marked non-auto-installable and surface manual instructions instead.
**Trade-offs:** Recipe coverage must be maintained per platform/package-manager; non-admin platforms surface manual instructions only. The post-install PATH enrichment assumes the installer wrote into either a known install directory or a directory already present in the enriched PATH; otherwise the user must add the binary to PATH manually.

> **Superseded in part by Decision #39.** Engine tools (`claude`, `opencode`, `copilot`, `codex`, `qwen`, `pi`, `cline`, `cursor`) are no longer PATH binaries installed via per-platform recipes — they are npm SDKs installed on demand into `~/.clopen/stack/engines`, and the "System Tools" panel was renamed to "Stack" (WS namespace `stack:*`). This decision still describes the **host tools** (`git`, `chrome`, `cloudflared`) accurately.

---

### 33. Codex Engine via `@openai/codex-sdk`

**Decision:** Wrap `@openai/codex-sdk` inside `backend/engine/adapters/codex/`. The adapter owns one `Codex` instance per project, drives a `Thread` lifecycle per turn, and uses an `AbortController` for cancellation. Authentication is dual-mode: API key OR ChatGPT browser OAuth, with per-account auth blobs swapped into Codex's `~/.codex/auth.json` location at stream time and snapshotted back after the turn (see `credential.ts`). MCP reuses the existing remote MCP HTTP server at `/mcp` via `getCodexMcpConfig()` — no new MCP infrastructure. Session forking is implemented by copying Codex's session rollout (`session-fork.ts`) so checkpoint restore works the same way it does for other engines.
**Rationale:** Codex ships a first-party SDK that already handles subprocess management (`codex exec`), so the adapter only needs to translate Codex's `ThreadStarted`/`TurnStarted`/`ItemStarted`/`ItemUpdated`/`ItemCompleted`/`TurnCompleted` events into `EngineOutput`. Dual-mode auth lets a single user run both a personal ChatGPT account and a workspace API key without process restarts. Reusing `/mcp` keeps tool execution in-process in the Clopen backend like every other engine.
**Trade-offs:** `@openai/codex-sdk` currently exposes no `canUseTool`-equivalent callback or permission/elicitation event, so AskUserQuestion is **unsupported** for Codex until the upstream SDK adds one. The auth-blob swap is racy if two Codex streams for different accounts start in the same tick — serialised at the engine registry layer.

---

### 34. Copilot Engine via `@github/copilot-sdk`

**Decision:** Wrap `@github/copilot-sdk` inside `backend/engine/adapters/copilot/`. One `CopilotClient` per project; abort controllers and active sessions are isolated by the per-project engine registry. The adapter consumes the SDK's `SessionEvent` stream (`onTurnStart`, `onReasoning`, `onMessageDelta`, `onAssistantMessage`, `onToolStart`/`onToolComplete`, `onUserInputRequest`, `onTurnEnd`) and converts each to `EngineOutput`. Authentication uses Copilot's device-code OAuth flow via the SDK; per-account credentials are persisted under `engine_accounts.credential` and applied per stream. Tool approval uses the SDK's `approveAll` strategy (Clopen surfaces approval/denial through the shared AskUserQuestion path via `onUserInputRequest`). Session forking is implemented in `session-fork.ts` so checkpoints integrate identically.
**Rationale:** Copilot's SDK exposes a clean callback-based session API that maps directly to Clopen's unified events, including a native `onUserInputRequest` hook — so AskUserQuestion works out of the box. Reusing the per-project engine registry pattern keeps Copilot isolated to its project the same way Claude/OpenCode are.
**Trade-offs:** `UserInputResponse` is not a public type export on the current SDK — derived locally from `onUserInputRequest`'s return type to avoid drifting from the SDK surface. Subagent events (`convertSubagentStarted` / `convertSubagentEnded`) are mapped explicitly because Copilot can spawn nested agents, which most other engines don't.

---

### 35. Qwen Engine via `@qwen-code/sdk`

**Decision:** Wrap `@qwen-code/sdk` inside `backend/engine/adapters/qwen/`. The SDK manages a `qwen` subprocess per `query()` call (CLI is bundled with the SDK from v0.1.1+), so the adapter only owns the per-project `Query` lifecycle, an `AbortController`, and a single-slot `pendingAskUserQuestion`. Authentication is paste-token only — `engine_accounts.credential` stores the OpenAI-compatible API key and the active account is read on every stream via `getEngineEnv()` (env-var SDK pattern, no client construction state, no Restart-Server UX needed). MCP reuses `/mcp` via `getQwenMcpConfig()`.
**Rationale:** Qwen's CLI is shipped inside the SDK package — no separate global install path to manage on PATH. Env-var-driven auth means swapping accounts is just changing `process.env` at stream time; no client to recreate, no auth-blob file to swap. Single-slot AskUserQuestion is sufficient because the SDK serialises permission prompts (only one can be pending at a time).
**Trade-offs:** Qwen's `canUseTool` callback signature **does not include the tool_use_id** at invocation time. The slot pattern compensates: the converter (which sees the assistant message carrying the block id) stamps the real `tool_use_id` onto the slot, and `resolveUserAnswer` accepts answers either matching that recorded id or for the slot when no id has been recorded yet (race on which lands first). Acceptable because permission prompts are serialised, but worth revisiting if upstream surfaces the id.

---

### 36. DB Client Architecture (per-driver adapters + ssh2 tunnel + idle-evicting connection manager)

**Decision:** Built-in database client lives in `backend/db-client/`. A single `ConnectionManager` (singleton) owns a `Map<connectionId, ConnectionEntry>`; each entry holds a `DbClientDriverAdapter`, an optional `SshTunnel`, and a `lastUsedAt` timestamp. Five drivers ship as separate adapters implementing a common `DbClientDriverAdapter` contract: `MysqlAdapter`, `PostgresAdapter`, `SqliteAdapter`, `MongoDbAdapter`, `RedisAdapter`. Each driver uses the ecosystem's native client (`mysql2`, `pg`, `bun:sqlite`, `mongodb`, `ioredis`) — no ORM. SSH tunneling uses `ssh2.Client` — `openSshTunnel()` opens a local TCP listener on an ephemeral port, forwards each accepted socket via `client.forwardOut`, and the adapter connects to `127.0.0.1:<localPort>` instead of the remote host:port. Connections idle longer than 10 minutes are swept by a 1-minute interval and disposed (timer is `unref()`-ed so it never blocks shutdown). All client-facing surface is WebSocket (`backend/ws/db-client/`): `connections` (CRUD), `schema`, `structure`, `query`, `io` (import/export), `access` (connection lookup guard). Shared types under `shared/types/db-client/`. Frontend stores in `frontend/stores/features/db-client.svelte.ts`.
**Rationale:** A driver-per-engine pattern mirrors the AI engine adapter pattern already in the codebase — adding a new database engine is a self-contained change behind a stable contract. Native drivers are non-negotiable: an ORM would either require a schema definition (impossible since users connect to arbitrary databases) or produce generic SQL that loses driver-specific features (Postgres `EXPLAIN ANALYZE`, MySQL `SHOW CREATE TABLE`, MongoDB aggregation, Redis cluster commands). The connection manager is in-process and singleton because every WS message for a connection must reuse the same live socket — a fresh connect-per-query would burn TLS handshakes and drown low-quota cloud DBs. Idle eviction with `unref()` keeps long-running clopen instances tidy without preventing shutdown. SSH tunneling via `ssh2` was prototype-verified end-to-end in PHASE 0 (`test-ssh-mysql.ts`) before integrating.
**Trade-offs:** Five driver dependencies in the bundle (Postgres + MySQL + Mongo + Redis + ssh2) — only loaded lazily when a connection of that driver actually opens, so the cold-start cost is bounded. Native drivers means each engine's quirks (Postgres binary protocol, MySQL packet sizes, MongoDB BSON, Redis pipelining) must be handled per-adapter. SSH tunnel uses password / private-key auth only (no agent forwarding yet). Plaintext credentials are stored in SQLite alongside the rest of the workspace data — same threat model as engine OAuth tokens.

---

### 37. Per-Engine Config-Dir Isolation (`{clopenDir}/engine/{engine}/user/`)

**Decision:** Every engine's CLI/SDK home dir is redirected out of the user's global location (`~/.codex`, `~/.copilot`, `~/.config/opencode` + `~/.local/share/opencode`, `~/.qwen`) into `{clopenDir}/engine/{engine}/user/` so Clopen never mixes with the user's own standalone CLI usage. The `engine/` parent groups all AI-engine state in one place, separate from Clopen's other data dirs (`{clopenDir}/snapshots/`, the DB). One helper — `getEngineUserConfigDir(engine)` in `backend/utils/paths.ts` — is the single source of truth, mirroring how Claude was already isolated via `CLAUDE_CONFIG_DIR`. Levers per engine: Codex `CODEX_HOME` (set in `credential.ts` + the SDK `env` in `stream.ts` + the `codex login` PTY env), Copilot `baseDirectory` (SDK forwards it as `COPILOT_HOME`), Qwen `QWEN_RUNTIME_DIR` (env + the `session-fork.ts` base), OpenCode `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` on the spawned `opencode serve` env. OpenCode additionally guards server reuse on a persisted data-dir key (`opencode.server.datadir`) so a server spawned with a stale/global dir is never reused — it respawns into the correct isolated dir. **No migration from the user's global dirs** (forward-only — see Trade-offs), but migration `043_relocate_engine_config_dirs.ts` does relocate Clopen's *own* earlier isolated layout (`{clopenDir}/{engine}/user/`, pre-`engine/`-parent) to the current path — safe because it only touches Clopen-created dirs, never the engine's global home. See `backend/engine/docs/lessons-learned.md` §10.19.
**Rationale:** Mixing Clopen's sessions/credentials/logs into the user's global dotfiles is invasive and surprising — it pollutes the user's own CLI history and risks Clopen and standalone usage clobbering each other's state. A single isolated dir per engine (shared across all of that engine's Clopen accounts) keeps session memory + fork-by-copy intact while the per-account auth-blob swap (Decision #33, §10.13) still handles multiple accounts inside it. No-migration was chosen deliberately: credentials live in the DB and re-materialize automatically, and the two shared-SQLite engines (Copilot `session-store.db`, OpenCode monolithic `opencode.db`) interleave Clopen and standalone sessions in one file with no safe per-session extraction — so copying would either drag in the user's private global sessions or risk DB corruption.
**Trade-offs:** Conversations created before this change lose engine-side resume continuity (their session/rollout files stay in the old global dir); the message history in Clopen's own DB is unaffected and still renders, but continuing an old chat starts a fresh engine session. Codex's SDK does **not** inherit `process.env` when `env` is passed, so the adapter must forward the full `getCleanSpawnEnv()` plus `CODEX_HOME`. Qwen isolation is partial — `QWEN_RUNTIME_DIR` relocates runtime output but the CLI's global `settings.json` still resolves to `~/.qwen` (no env override); harmless because Clopen uses paste-token auth. OpenCode follows XDG and namespaces under an extra `opencode/` segment, so its state lands at `{clopenDir}/engine/opencode/user/opencode/` (one level deeper than the other engines) — there is no supported env var to flatten it.

---

### 38. External MCP servers proxied through the bridge (`/mcp/ext/<slug>`)

**Decision:** User-installed (external) MCP servers are no longer connected directly by each engine. Each enabled server gets its own endpoint `GET/POST/DELETE /mcp/ext/<slug>` on the same Streamable-HTTP bridge the internal `clopen-mcp` tools use (`backend/mcp/external/proxy.ts`, routed in `backend/index.ts`, lifecycle in `backend/mcp/internal/remote-server.ts`). Clopen connects to the real upstream (stdio subprocess or remote URL) as an MCP **client** and re-exposes its tools there. Every per-engine builder in `backend/mcp/external/config.ts` now emits the **identical** shape — a loopback bridge URL plus the in-memory service-token header — regardless of the upstream's real transport; the SDK config key is the only per-engine difference (Qwen `httpUrl`, Codex `http_headers`, Copilot `tools:['*']`, etc.). The proxy reads upstream `tools/list` with a **raw** JSON-RPC request (bypassing `Client.listTools()`), **drops each tool's `outputSchema`**, and repairs dangling `$ref`s in `inputSchema` before re-serving. Upstream OAuth/API-key credentials are injected once by the proxy (`resolveServerRow`); the engine→bridge hop only carries the service token. The upstream client (and any stdio subprocess) is created lazily per bridge session and torn down on session close.

**Rationale:** Engines discover tools via the MCP SDK's `Client.listTools()`, which eagerly compiles an Ajv validator for every tool's `outputSchema`. A single unresolvable `$ref` (Stitch ships `#/$defs/ScreenInstance`) makes that throw; the engine CLIs' `discoverTools` swallow the error and surface **zero** tools while still reporting the server "connected" — which silently hid all remote-server tools on Qwen and all external tools on Copilot, even though the servers connected. Owning the upstream client lets Clopen read schemas leniently and sanitise them, so one malformed schema can no longer take down a whole server. Routing through the existing bridge (rather than a new listener — see §10.12) also unifies stdio and remote into one shape per engine, centralises credential handling, and makes the Settings `mcp:status` probe truthful (a server only works end-to-end when its tools are actually serveable). Verified end-to-end: a default-Ajv client that crashed connecting straight to Stitch returns all 14 tools through the proxy.

**Trade-offs:** External stdio subprocesses now run in Clopen's process tree (per bridge session) instead of the engine's — consistent with how internal tools execute, but Clopen owns their lifecycle. Codex's per-tool `approval_mode` auto-approval still can't be set for external tools (names are unknown when the synchronous builder runs), so non-interactive `codex exec` may cancel external MCP calls — unchanged by the proxy. `outputSchema` is dropped wholesale rather than validated, so engines that consume structured tool output lose it for external tools; non-Claude engines don't rely on it and the alternative (crashing the whole server) is worse.

---

### 39. Engine SDKs installed on demand into a clopen-managed Stack dir (not bundled)

**Decision:** No engine SDK ships in the clopen global install. Every SDK package (`@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk` + the pinned-exact `@github/copilot` CLI, `@openai/codex-sdk`, `@qwen-code/sdk`, `@opencode-ai/sdk`, `@earendil-works/pi-*`, `@cline/sdk` + `@cline/agents`, `@cursor/sdk`) moved from `package.json` `dependencies` to `devDependencies`, and `package.json` is the **single source of truth** for each engine's exact pinned version. At runtime clopen installs them **on demand** into a clopen-managed, self-contained bun project at `~/.clopen/stack/engines` — `getStackEnginesDir()` in `backend/engine/sdk-loader.ts` is the sole definition of that path — never `bun add -g`, never the user's global bun store, never their project. `install-runner.ts` bootstraps the dir + a minimal `package.json`; engine recipes install there by setting `recipe.cwd`, with no manual-command instructions (fully clopen-managed). Adapters reference SDK types only via `import type` and load the real module at point of use with `loadEngineSdk(engine, pkg)` (`Bun.resolveSync(pkg, stackDir)` + dynamic import). `loadEngineSdk` **version-guards** the load: an SDK whose installed version ≠ the pinned version throws `EngineNotReadyError` (`reason: 'not-installed' | 'needs-update'`), surfaced in the chat error surface so the user updates it in Settings → Stack first. Detection is stack-dir based everywhere (`readEngineSdkVersion` in both `getToolStatus` and the engine-picker `status.ts` handlers); `ToolStatus` carries `requiredVersion` + `needsUpdate`. `pi`, `cline`, and `cursor` became installable Stack cards (previously read-only InfoCards). The internal MCP layer is decoupled from the Claude SDK to match: `backend/mcp/internal/` holds only engine-agnostic raw tool defs (on `@modelcontextprotocol/sdk`), and the Claude-SDK-shaped in-process servers are built lazily in the now-`async` `getEnabledMcpServers()` on the Claude path only. The Settings panel formerly labelled "System Tools" is now **"Stack"** — and the rename goes all the way down: WS namespace `stack:*` (`backend/ws/stack/`), settings section id `stack`, UI in `frontend/components/settings/stack/`, docs in `backend/engine/docs/stack.md`. No `system-tools` identifier remains. Future Stack expansion (runtimes via mise, services via containers, per-project versioning, a capability matrix) is specced separately in `docs/stack-roadmap.md`.

**Rationale:** Bundling the SDKs dragged 200–300 MB of native CLI binaries into the global install, and a single failed tarball extraction aborted the entire `bun add -g @myrialabs/clopen` — a hard blocker on Windows. Installing on demand into a managed dir keeps the global clopen install small and reliable, avoids polluting the user's global bun store or their project's `node_modules`, and survives clopen reinstalls. Pinning versions in `package.json` means an on-demand install always matches the exact version clopen was tested against, so `version-check.ts` intentionally has no update source for engines (no "newer version" nag) and the "Check for Updates" button is hidden for them; the Stack card shows "Update required" only when the installed version drifts from the pinned one. Version-guarding the loader turns a subtle "engine present but wrong version" failure into an actionable prompt instead of a runtime crash.

**Trade-offs:** First use of an engine requires an explicit install step (surfaced in Settings → Stack) rather than working out of the box. The managed dir is an extra on-disk location clopen owns and must keep consistent with `package.json`. Bumping an engine version in `package.json` makes every existing install show "Update required" until the user updates it. `getEnabledMcpServers()` becoming `async` rippled to its callers on the Claude path.

---

### 40. Reasoning effort stays native per engine (no cross-engine normalization)

**Decision:** The reasoning/thinking-effort level a user picks is an **opaque, engine-native token** carried unchanged from the model catalog to the SDK. A model opts in by exporting `capabilities.reasoningControl` (`{ levels: {value,label}[], default }`) from its adapter's `models.ts`; the level rides the turn as `EngineQueryOptions.reasoningEffort` (a plain `string`), is persisted per session in `chat_sessions.reasoning_effort` (migration `065`) and per model in `AppSettings.reasoningDefaults`, and is stamped onto `MessageEngine.reasoningEffort` for the Raw Message view. Only the adapter that produced a token reads it: Claude maps it to `thinking` + `effort`, Codex to `modelReasoningEffort`, Copilot to `SessionConfig.reasoningEffort`, Pi to `thinkingLevel`, and Cursor to a `ModelSelection.params[]` entry — for which the token itself encodes the parameter id as `"<paramId>::<value>"`. Levels are derived from the SDK's own payload wherever it reports them (`supportedReasoningEfforts`, `getSupportedThinkingLevels`, `ModelParameterDefinition`) and hardcoded only in the two static catalogs. Every adapter clamps an unknown token back to its engine default. Engines with no knob (Qwen, OpenCode, Cline) simply omit the field, and the UI — which never branches on engine type — renders no control. Choosing a level broadcasts `chat:reasoning-sync`, mirroring `chat:model-sync` / `chat:profile-sync`.

**Rationale:** No two engines agree on either the field or the vocabulary: `minimal` exists only on Codex, `max`/`xhigh` only on some Claude models, Pi's set is per-model, and Cursor has no dedicated field at all. A normalized `low | medium | high` scale would be lossy in both directions — it cannot express `off`, and it either hides levels a model supports or offers levels it does not. Making the token opaque means every layer between the two adapter files is a pure carrier, so adding an engine with a sixth vocabulary touches only that engine's `models.ts` and `stream.ts`. Driving the UI off `reasoningControl` rather than an engine list keeps the picker free of per-engine conditionals, and encoding Cursor's parameter id inside the value avoids widening `EngineQueryOptions` for one SDK's shape.

**Trade-offs:** Levels cannot be compared or carried across engines — switching engine mid-session re-seeds the level from that model's default rather than mapping "high" to "high". The frontend must keep `chatModelState.reasoningEffort` at the *effective* value (an `$effect` re-seeds it on model change) so a level valid for the previous model can't leak into the next request. Because the token is a bare string, a stale value is only caught by the adapter's clamp, not by the type system.

---

### 41. The engine catalog is the only source of truth for a model's provider

**Decision:** A `providerSlug` supplied by a client is a **hint**, never authoritative. Every one-shot `generateStructured` call site (AI commit message, branch name, artifact authoring) routes through `resolveGenerationTarget(engine, modelId, providerHint)` in `backend/engine/resolve-model.ts`, which resolves the provider — and the owning account — from the engine's own catalog (reading the in-memory registry filled by `models:list`, fetching only on a miss) and throws an actionable "pick it again in Settings → Models" error when the model belongs to no provider that engine offers. On the frontend, the fields that describe one choice are written together via `modelFieldsOf(...)` (`frontend/utils/model-override.ts`) so `provider`, `modelId`, and `modelName` cannot be persisted apart.

**Rationale:** Settings persist engine, provider, and model as separate fields, so any UI that updates two of the three leaves the provider pointing at a different engine. That drift is invisible on the five engines that key off `modelId` alone (Claude, Codex, Qwen, Copilot, Cursor) and fatal on the three that read the slug — OpenCode passes it as `model.providerID`, Pi and Cline resolve their account by it. A `commitGenerator.provider` stuck at its `'anthropic'` seed therefore surfaced as "OpenCode returned empty response" while Claude Code looked perfectly healthy. Deriving from the catalog fixes configs already saved wrong, covers new engines without touching any call site, and turns a deep engine-specific failure into one clear message.

**Trade-offs:** A catalog fetch may be needed on a registry miss, adding latency to the first generation after a restart. When the catalog itself is unreachable the resolver falls back to the caller's hint, so the old failure mode is still reachable — just logged. Adapters report `account.id: 0` today (account is a separate per-chat dimension with no picker on these routes), so the resolved account is informational and engines still fall back to their active account.

---

### 42. Engine adapters load on demand, and the shipped/dev boundary is enforced, not documented

**Decision:** `backend/engine/index.ts` reaches every adapter through `ENGINE_LOADERS`, a total `Record<EngineType, () => Promise<AIEngine>>` of dynamic `import()`s — nothing in the registry statically imports an adapter, so boot loads no engine. `getEngine` / `getProjectEngine` are therefore async and cache the in-flight promise (concurrent callers share one instance; a failed load is evicted so a Stack install can be retried without restarting); `findProjectEngine` is a sync lookup that returns `undefined` rather than creating, for callers acting on a stream that is already running (cancel, `AskUserQuestion` routing). A load failure is deliberately **not** caught in the registry: `checkEngineSetup` (`backend/engine/engine-setup.ts`) remains the single place that decides what an unusable engine means to the user, surfacing an "Open Settings → Agents → Install" message that `ErrorMessage.svelte` renders as a one-click button. Alongside it, the "SDK types via `import type` only" rule of Decision #39 is now machine-enforced: ESLint rejects value imports of any `devDependency` from shipped runtime code (`bin/`, `backend/`, `shared/`, `scripts/start.ts`) with the restricted list derived from `package.json`, and three tests cover what types cannot see — `backend/shipped-runtime-imports.test.ts` walks the shipped module graph with `Bun.Transpiler.scanImports` (catching the `await import()` ESLint cannot see, plus undeclared packages and imports of unshipped files), `backend/engine/index.test.ts` fails if any adapter is reachable from boot or if a loader is wired to another engine's class, and `backend/engine/install-recipes.test.ts` fails on an engine SDK that is undeclared, floated, or named differently by `ENGINE_SDK` than by `ENGINE_PACKAGES`.

**Rationale:** Decision #39's rule was written down and still violated three times — Qwen's `stream.ts`, OpenCode's `server.ts`, and Pi's `models.ts`/`stream.ts` — because a value import of a devDependency is invisible in development (the repo has it) *and* intermittently invisible in production: a global install resolves bare specifiers through `~/.bun/install/global/node_modules`, which is shared by every globally installed package, so whether it crashed depended on what else lived in that store. Pi's break was reported as "only on some devices, mostly fresh installs", and reinstalling bun appeared to fix it because that rewrites the ambient store rather than the code. A rule with no local signal cannot survive review, so it had to become a failing build. Static adapter imports made the blast radius wrong on top of that: one unresolvable module killed the whole backend at boot, taking Claude away from users who had never selected Pi. Loading per engine puts the failure on the engine being asked for.

**Trade-offs:** Engine creation is async, which rippled through `getEngine`/`getProjectEngine` call sites (small — the two `initialize*` wrappers were already async). A genuine module-load failure — as opposed to a missing SDK — still reaches the user as a raw error string with no action button, because `checkEngineSetup` runs after `initializeProjectEngine` and only probes the stack dir; translating it into an install prompt was rejected as worse than the raw message, since it would send users reinstalling for a bug no reinstall can fix. The guards cover resolvability, not compatibility: a declared dependency that resolves but breaks under Bun (the typebox/bson class) is still unguarded. Non-literal dynamic imports (`import(someVariable)`) are invisible to both layers; today only `sdk-loader.ts` does that, deliberately, via `Bun.resolveSync` against the stack dir.

---

## The Clopen assistant (v0.5)

### 43. The assistant is Clopen itself, driving agents through one control surface

**Decision:** The chat that used to be "Home" is Clopen, the assistant. It does not write project code: it turns a request into a task, hands each part to a specialist agent with a complete brief in that project's session, verifies the result itself (the browser, `terminal.run`, files), and corrects or completes. Everything it can do is an action in `backend/control/agent/` — tasks, automations, scripts, skills, secrets, the Inbox, files, shell, git, databases, and `api.call` over every WebSocket route — exposed by one internal MCP server, `control`, as one tool (`run`) taking a batch of steps with `$name.field` references between them. Its persona, autonomy policy, the owner's profile, the last two days of the journal and a live snapshot (open tasks, Inbox, automations) are prepended to every turn in its workspace (`backend/assistant/brief.ts`), the same way the memory block is.

**Rationale:** The WebSocket API is already the complete, permission-checked description of what Clopen can do, and the control catalog already ran routes as a user through it (`callRouteAs`). Building the assistant on that rail means it can do anything the web UI can, with the web UI's rules, without a second implementation. One batched tool (the pattern of the `browser` and `memory` servers) keeps the whole surface in one description and makes a plan a single call. Injecting the brief per turn keeps it engine-agnostic: every agent that can run the assistant gets the same instructions, and the snapshot spares a round trip to find out where things stand.

**Trade-offs:** The tool description lists every action and is long. `api.call` exposes route names to the model, so route naming is now part of the agent's interface. The stored project kind stays `home` (a key, not a label) to avoid rebuilding the `projects` table.

---

### 44. Tasks are woken by turns, never polled, and stop on lack of progress — not on a budget

**Decision:** `task.dispatch` returns immediately. Each dispatch names the specialist role the agent works as (Writer, Developer, Researcher…), stored on the task's session link and shown to the owner as one status line per specialist. When a task session's turn ends (`stream:lifecycle`), Clopen reads the answer and the turn's changed files, records them on the task timeline, and sends the assistant a report in its own session (queued behind its current turn if busy). An agent's `AskUserQuestion` wakes the assistant to answer it (or goes to the Inbox when the task asks first). `task.progress` (and Telegram `/tasks`) returns a short progress note with a screenshot of the Preview Browser tab an agent of the task is driving. There is no cap on iterations or time; a task is marked stalled when three turns in a row change no files and answer (or fail) the same way, which raises an Inbox item and stops waking the assistant.

**Rationale:** A blocking "wait for the agent" tool call would hold the assistant's turn open for an hour, make it unreachable to the owner, and die with the process. Event-driven wake-ups survive restarts (tasks and their sessions are rows) and cost nothing while an agent works. The owner chose full autonomy by default, so the stopping rule had to be about progress, not quantity — a long task that keeps changing things is working. Roles are free text rather than a fixed roster so the assistant can pick whatever expert a task needs; showing them as one line each, not an animated office, keeps the view readable.

**Trade-offs:** The stall signature is a heuristic (normalised answer or error, ignoring hashes); an agent that loops with small file churn is not caught. A server restart mid-turn loses that turn's report (the stream is gone), so the task waits until the assistant or owner nudges it. Internally a task is still a `missions` row and its routes keep that table name; every name an agent or the owner sees says task.

---

### 45. Irreversible actions are approved in the Inbox; everything else is undoable and just runs

**Decision:** Every agent action declares a risk — `read`, `write` (undoable from inside Clopen: restore points, branches, worktrees) or `irreversible` (deleting data, force-pushing or pushing main, deploying, merging, writing to a database, publishing). Irreversible steps become an approval in the Inbox (with push and chat-app delivery) unless the owner allowed them in Settings; approving runs the action as the agent that asked and tells that agent the outcome in its session. A separate, absolute blocklist keeps credentials, sign-in, wiping Clopen, raw terminals and the browser host bridge out of reach whatever the owner allowed. Every step is written to `control_audit`. Database access is per connection (`none` default, `schema`, `read`, `write`), enforced by classifying each statement with the query console's classifier.

**Rationale:** Asking before every step defeats autonomy; asking before nothing makes an autonomous agent with the owner's credentials a liability. Making ordinary work undoable and asking only for what cannot be undone keeps both. External content that starts an automation (webhook bodies, watched pages) is passed to agents as quoted, untrusted context, because it is the obvious prompt-injection path into an agent that can push code.

**Trade-offs:** Risk for `api.call` is inferred from the route's verb, so a route named unusually can be mis-classed (the blocklist is the backstop for anything sensitive). Shell commands are classified by pattern; a destructive command written unusually still runs as `write`.

---

### 46. Automations: one 30-second clock, one run at a time, and failures reported once

**Decision:** Automations (stored as jobs in `backend/jobs/`) have four triggers — schedule (a small in-repo five-field cron evaluator), event (verified integration webhooks), watch (a URL or file fingerprinted every N minutes; the first look is a baseline), check-in (the assistant goes through a checklist and only reports when something needs attention) — and four actions: script (no tokens), skill, prompt or task. The assistant is told to write and test a script first whenever the work is a fixed sequence, and to use a prompt only where each run needs judgement. One timer checks due automations every 30 seconds; the next run is always recomputed from the trigger, never accumulated. A run missed while Clopen was off runs once (`run-once`) or not at all (`skip`), never once per missed slot. Only one run is ever in flight: a start while any run is still going is dropped (`skip`, default) or held until it ends (`wait`, several starts collapse into one). Results reach the owner by a delivery policy — every run, only when the result changed (default for watch and check-in), or only failures — and failures are aggregated: one open "isn't working" Inbox item per automation, settled with a short "works again" by the next success. A run the owner stopped is recorded as stopped, not failed. Clopen can register itself with the OS's per-user startup (`clopen service install`, or the toggle in Settings) so automations survive a restart; it is off by default.

**Rationale:** Real usage showed the failure mode: an LLM-driven job that took longer than its interval started again on every tick (only the latest run was checked for "running"), four ran in parallel, and the owner got four identical failure reports. Checking for any running run, and reporting a broken automation once, fixes both. The cron surface is small enough that an in-repo evaluator with tests beats a dependency deciding when an agent spends money. Recomputing from the trigger prevents drift after sleep. The startup integration uses launchd/systemd user units/Task Scheduler at the user level so it needs no administrator rights, and it is not loaded immediately on macOS because the running Clopen already holds the port.

**Superseded in part by 57:** actions became recipes, `checkin` gave way to `once` and `manual`, and "Automations" are now called Flows.

**Trade-offs:** No time zones other than the server's local time (times are shown with the zone named). Flows do not run while Clopen is not running, which the Flows view says plainly rather than promising otherwise. "Changed" is a whitespace- and time-insensitive text comparison, not a semantic one.

---

### 47. The learning loop turns repetition into scripts and skills, with revisions

**Decision:** From the stream every engine already produces, `backend/assistant/learning.ts` counts the meaningful shell commands an agent runs per turn (builds, tests, restarts — never reading commands like `ls`/`cat`/`grep`) as runs of 2–4; a run seen in three turns across two sessions becomes a script (saved automatically when autonomous, suggested in the Inbox when asking first). The owner's prompts are compared by word overlap; three alike from two sessions ask the assistant to write a skill (or offer that in the Inbox). Every skill save — by the owner or by Clopen improving it — is a row in `skill_versions` and can be reverted. A Preview Browser recording (teach a task) becomes a skill (Browser Automation steps plus a walkthrough) or a script (replays the page loads).

**Rationale:** Analysis of real usage showed the repeated work is operational sequences (verification gates, restarts, environment loading) and recurring requests with standing rules (PR checks, issue workflows) — exactly what scripts and skills are for. Scripts remove tokens from recurring jobs entirely; skills make the assistant's briefs better over time. Versioning makes self-improvement safe to allow.

**Trade-offs:** Similarity by word overlap misses paraphrases and can merge unrelated requests that share vocabulary; the threshold is conservative. Learning state is a bounded settings row, not a table.

---

### 48. Settings is how Clopen behaves; the Library is what it knows

**Decision:** Settings went from 23 sections in 5 groups to 15 in 6 (Clopen, AI, Workspace, Devices & Sharing, General, System). Engines and Stack became one Agents section where each agent goes Install → Sign in → Ready in place; sections with more than one part (Models, Memory, Git, Notifications) show them as tabs instead of one long scroll. Skills, Scripts, Specialists (was Subagents), Rules (was Instructions), Toolsets (was Profiles), Integrations and Secrets live in a separate Library, opened from a fixed sidebar item. Only terms Clopen invented were renamed — Home → Clopen, Engines/Stack → Agents, Artifacts → Library, Profiles → Toolsets, Instructions → Rules — down to WebSocket route namespaces (`engine:` → `agents:`, `stack:` → `agents:install-*`, `project-artifacts:`/`artifacts:` → `library:`, `profiles:` → `toolsets:`, `instructions:` → `rules:`) and stored keys (`artifactGenerator` → `libraryGenerator`, migration 088). In the UI, everyday words replaced the remaining jargon — Session → Chat, Engine → Agent, Subagents → Specialists, Checkpoint → Restore point, Worktree → Workspace copy, Tunnel → Public Link, DB Client → Databases, Personal Access Token → Sign-in key, No Login / With Login → Just this computer / My other devices too — while code, routes and stored keys for those keep their names. Terms whose meaning is the name (SSH, Git, MCP, Skills) were kept.

**Rationale:** A first-time user could not tell where anything lived ("Infrastructure", "Artifacts & Access"), Memory appeared twice, and settings were mixed with things the owner builds. Splitting by intent and naming by meaning makes both places scannable for a newcomer without hiding anything from a developer.

**Trade-offs:** The internal names (`backend/engine`, `worktrees`, `subagents`, `checkpoint` components, the `mission`/`job` tables) no longer match the labels; renaming them would be churn without a user-visible effect, and the mapping is one word each.

---

### 49. The setup wizard is versioned, and every install goes through the new one once

**Decision:** Onboarding completion is a version (`ONBOARDING_VERSION`, now 2) stored in its own settings row (`system:onboarding-version`), written only by `markOnboardingComplete()`. An install that completed an older version — every 0.4 upgrade — goes through the new wizard once, starting from what it already has (sign-in mode, accounts, models). It has three steps: Access (plus the sign-in key, shown once, when one was just created), AI (OpenCode installs itself; an API key or another agent can be added in place) and Preferences (ask before acting, start with the computer, dark mode). No notifications step, no profession picker and no first task: the chat itself is where the owner says what they want, and its placeholder rotates examples of the range. New installs default to the compact message layout; existing users keep theirs.

**Rationale:** "What's New" is for release notes; meeting the assistant needs a few choices. Each extra step is a place to drop out, so anything that can be decided later, in context, is. Keeping the version in a row nobody else writes fixes the earlier class of bug where a stray write to the system-settings blob dropped the marker and sent working installs back into the wizard.

**Trade-offs:** Upgraded users see the wizard once even if they would rather not; every step is pre-filled so it is a few clicks.

---

### 50. One conversation, many sessions: Clopen routes each message by meaning

**Decision:** The owner talks to Clopen in one place; Clopen decides per message which session it belongs in (`backend/assistant/conversation.ts`). Busy current chat → a parallel session answers at once. Past 120 messages → a fresh session continues it. About something else → a fresh session. "Something else" is the cosine similarity of the message and the session's recent owner messages under the local embedding model (lexical overlap when the model is not installed); short replies and words that point back ("that", "lanjut", "tadi"…) always continue, and time since the last message only lowers the bar slightly — never decides. A fresh session carries a context capsule (the source session's last exchanges, tasks under way, the recent journal) prepended to its first turn only; anything older is read on demand (`chat.history`, `chat.read`, `journal.search`). The assistant can also close a chat for routing (`chat.new-topic`). Routing applies to the owner's own messages in the web UI (`assistant:route`, called before sending) and in Telegram; system prompts (task reports, automation runs) name their session and never pass through it. Heavy work is pushed out of the conversation entirely: the brief tells the assistant to answer, decide and delegate here, and to run anything longer than a minute or two as a background task.

**Rationale:** Usage showed people never press "new chat": one session grew to hundreds of messages mixing unrelated subjects, every turn paid for all of it, and a 90-minute job inside the chat made Clopen unreachable. A fixed idle-hours rule split conversations that were still going and kept unrelated ones together; meaning is the signal that matters. Parallel sessions instead of a queue keep the owner from waiting behind a long turn.

**Trade-offs:** The similarity threshold is a tuned constant; a borderline message can land on either side (ambiguous cases continue). The capsule is lost if the server restarts between routing and the first turn — the fresh session then starts with the brief and journal only.

---

### 51. Memory beyond a chat: a journal, the owner's profile, and an encrypted secrets vault

**Decision:** Three stores in migration 089. `journal_entries` is the chronology — each finished exchange in Clopen's chat (what was asked → what came of it), every task started and finished, every automation result — with a 48-hour digest in the brief and full-text search through `journal.search`. The owner's profile is a short note the assistant rewrites itself (`profile.update`, settings row `assistant:profile`) and sees in every brief. `secrets` holds passwords, tokens and keys sealed with the install's master key (the same envelope as other credentials); agents read one by name with `secret.get`, which records the use, and memory, scripts and prompts refer to the name only. The audit trail redacts secret-looking arguments.

**Rationale:** Long-term memory holds what was learned, not what happened when; without a journal a new chat could not answer "what did we do yesterday". The assistant must never send the owner off to do something by hand, so it needs somewhere safe to keep the credentials it asks for — once — instead of asking again or leaving them in chat history.

**Trade-offs:** A secret is necessarily plain text inside the agent's context while it uses it. The journal is capped at 20,000 entries. Messages already in chat history that contained a password are not rewritten.

---

### 52. Auto-sync: every write announces itself, whoever made it

**Decision:** The WebSocket router has an after-request hook. After any successful write request (risk not `read`) in a shared namespace — projects, skills, subagents, rules, toolsets, mcp, integrations, settings, agents, library, permissions, chat-apps, db-client, worktrees, models — the server emits `data:changed { namespace }`, coalesced per namespace over 150 ms. It fires for browser requests and for in-process calls (`invoke`, which the control surface, chat apps and automations all use). The frontend maps each namespace to the refetch of what the screen shows (`frontend/services/data-sync.ts`), and views can subscribe for their own lists.

**Rationale:** A project added by Clopen through MCP did not appear in the sidebar until a reload: most modules only announced changes for the paths their own UI used. One generic rule at the router covers every origin, present and future, without each handler remembering to emit.

**Trade-offs:** The event carries no data, so a change costs a refetch. Namespaces with their own live events (chat, files, git, terminal, preview, assistant) are excluded rather than double-announced.

---

### 53. Built-in MCP servers are named for what they are: `browser`, `memory`, `control`

**Decision:** The internal servers were renamed `browser-automation` → `browser` (tool `browse`), `memory-graph` → `memory` (tool `remember`), `clopen` → `control` (tool `run`). Migration 089 renames their rows, tool overrides, toolset items and permission rules. User-added servers whose slug would collide get an `x-` prefix.

**Rationale:** Short names read better in every agent's tool list and in Settings. Engines other than Claude Code see every internal tool in one shared bridge namespace by its bare name, so tool names must be unique across servers — hence three distinct verbs instead of reusing the server names.

**Trade-offs:** Saved prompts or skills that mention the old tool names by hand need updating; the brief and descriptions Clopen generates were updated.

---

### 54. Telegram: the everyday seven in the menu, one message per event

**Decision:** The bot's `/` menu shows four commands — `/tasks` (one-off and repeating), `/stop`, `/clear`, `/help` (revised in the fifth pass; before: `/new`, `/tasks`, `/inbox`, `/stop`, `/project`, `/model`, `/help`) — declared with `menu: true` and ordered by `MENU_ORDER`. Every other command (including `/undo` and `/retry`, taken out of the menu in the second pass, and `/flows`, folded into `/tasks` in the third) still works and is listed under "More" in `/help`. Replies carry no labels or sign-offs; a reply with no text says what the turn did ("Done — used Clopen (3×) and the browser."). An Inbox item is not broadcast to a chat that is waiting on the turn it came from, so the owner gets the answer once. `/tasks` sends a progress note with a screenshot when an agent is in the browser. Plain messages to Clopen go through the same topic routing as the web UI.

**Rationale:** A menu of thirty commands is one nobody reads, and the analysis of real chats showed duplicate deliveries (the Inbox broadcast plus the chat's own answer), prefixes like "Report:" and a trailing "Open the Inbox in Clopen" on every message — noise that made the important message harder to see.

**Trade-offs:** Hidden commands are discoverable only through `/help`. `/model` stays `/model` (not `/ai`) because people already know it.

---

## The Clopen assistant, second pass (v0.5)

### 55. Clopen is the owner's assistant by construction, never a project worker

**Decision:** In Clopen's own project, file-writing, shell and sub-agent tools are denied per engine (`backend/assistant/manager-policy.ts`, applied as one more layer in `resolvePermissionsFromDb`): Claude gets `disallowedTools` plus `ENABLE_TOOL_SEARCH=false` so Clopen's tools are loaded up front, Codex runs with a read-only sandbox, the others get their tool names denied. What it can do is talk, look, and hand work out through intent tools.

**Rationale:** The database of real chats showed that only one model (GPT-6 Luna on Codex) delegated as told; Claude Sonnet and Gemma started building the app inside Clopen's chat with Write and Bash, and Claude's deferred tool search hid Clopen's own tools until it looked for them. A sentence in a prompt does not survive a coding preset; removing the tools does.

**Revised (third pass):** "manager" was the wrong word — Clopen kept verifying, reviewing and dispatching itself, and specialists for tasks without a project were run inside Clopen's own chat, where they could not work and delegated again (two duplicate tasks for one request). Now: Clopen does one-off things itself (screenshot, lookup, reminder, a note in a connected service, `terminal.run` confined to its scratch folder) and hands project work to `delegate`, whose agents build and test it — Clopen never verifies. By construction: the actions that change a project (`files.write`, `git.commit/branch/push`, `task.create/dispatch/complete/fail`) are not registered, `api.call` refuses writes in project namespaces (files, git, worktrees, terminal, snapshot, checkpoints, deployments), and the recipe engine refuses a task step without a project or in Clopen's own project.

**Trade-offs:** A tiny edit the owner asks Clopen to make in place becomes a one-step crew instead of an instant change. A new engine needs its tool names added to the policy.

---

### 56. Intent tools with flat arguments, and a text fallback

**Decision:** The `control` server exposes one tool per frequent intent — `delegate`, `automate`, `remind`, `connect`, `send`, `ask`, `status` — next to the general `run`. Each takes flat, forgiving arguments and is a single `run` step underneath, so risk, scope, approval and audit are unchanged. Arguments are validated before an approval is raised (`validate` on the action), so the owner is never asked to approve something that will then be refused. When a model cannot call tools at all, a fenced ```` ```clopen ```` block in its reply is parsed and executed the same way.

**Rationale:** Small models failed on nested JSON schemas (`run` with an array of `{action, args}`), not on the work. The approve-then-blocked sequence seen with `mcp:install` was the worst outcome: the owner did their part and nothing happened.

**Trade-offs:** More tools in every engine's list. The text fallback only covers the intent tools.

---

### 57. Flows and crews run on one recipe engine; structure is code, judgement is a model

**Decision:** A recipe is a list of plain steps — `Do` (an agent turn), `Run` (a script), `HTTP`, `Use` (a connected service's tool), `Tell`, `Ask`, `Approve`, `If`/`Else`, `Choose`/`Case`, `For each`, `In parallel`, `Repeat until`, `Review … by roles`, `Flow`, `Wait` — with results named `$name` (`shared/types/recipe.ts`, text form in `shared/utils/recipe-text.ts`). `backend/recipes/engine.ts` runs it: it decides order, loops, branches, budgets and stops; models are asked only for work (`Do`) or small schema-bound judgements (`think()` on the Background model: a condition, a case, a review verdict). Checks like `$price > 100` or `$list is empty` are decided in code for free. Every flow (`jobs`) and every delegated task (`missions`) carries a recipe; crews are recipe templates (`backend/recipes/crews.ts`: build, research, content, general) with review loops by different roles, testing in a real browser, a share link, and an optional launch that waits for approval. Recipe structure is English only; the owner speaks any language and the AI writes the canonical form. Migrations 087/089 were edited in place (still unreleased) rather than adding a 090.

**Rationale:** Orchestration left to the model is exactly what differed between cheap and flagship models. With the structure fixed in code, a free model and a flagship walk the same plan and differ only in the quality of each step. One engine for flows and crews means one place to get loops, budgets, approvals and traces right. Language-specific keyword lists were removed everywhere: a word list is wrong for every language it does not list.

**Revised (third pass):** crews are sized to the request, not to a quota. The first templates put a researcher, a designer and a five-persona review panel on "write 7 days of crypto prices to Notion"; reviewers pushed a specialist who had correctly stopped (the site had no sign-up) towards a paid checkout; and a loop that never passed was reported "✅ done". Now: build = Developer → Tester in a real browser → Developer fixes → share link; document = Writer → one reviewer; general = Specialist → one reviewer; a Researcher only when the request depends on facts, a Marketer only when a launch is asked for. Every stage hands over a full report (the short-reply rule applies only to the owner). A review can return `needsOwner` (the owner is asked once, at most twice per run) or `impossible` (the task stops honestly), and a loop that runs out or stops improving makes the run `unfinished` — `RunResult.outcome` carries done / unfinished / impossible / declined / cancelled / failed and the task's status and message follow it. Steps carry a human `title` for the canvas.

**Trade-offs:** A recipe is less flexible than letting a strong model improvise. Dev databases that already ran the earlier 087–089 need a reset.

---

### 58. Flows learn, with versions

**Decision:** After a failed run, `repairRecipe` asks the Background model to rewrite the failing part, retry as is, or give up, records the lesson in the flow's notes (fed to its `Do` steps) and saves a new version; the run is retried once. After five successful runs, a step whose output never changed is considered for freezing into a script: the model writes it, Clopen test-runs it, and only a matching result replaces the step. Every change is a row in `recipe_versions` and can be reverted from the Flows view. A daily budget per flow pauses it when reached; each run records its cost.

**Rationale:** The owner asked for flows that get better on their own, the way the learning loop already improves skills. Freezing turns paid AI steps into free scripts only when the evidence says the answer is fixed.

**Trade-offs:** A repair can be wrong; it is visible as a version with its note and is one click to undo.

---

### 59. Cards reach the owner where they are; Inbox becomes "Needs you"

**Decision:** Anything that needs the owner is a card (`backend/assistant/cards.ts`) — `ask`, `approve`, `connect` (a sign-in link), `secret` (fields that go straight to the vault) — stored as an inbox row and delivered to Clopen's screen and to Telegram (`announceCard`), where a reply or a button answers it. Recipe steps wait on cards. Reports carry files: `send` copies them into Clopen's data folder and they are served to signed-in clients only (`/api/assistant/files/:id`, SVG/HTML as downloads) and sent as photos/documents to Telegram. The Inbox page is gone: the sidebar shows "Needs you" (only open questions, approvals and stuck tasks), and Clopen's screen shows cards above the chat and updates in a side panel.

**Rationale:** Owners were told to "open the Inbox in Clopen" while sitting in Telegram, and could not answer there; images an agent made could not be shown anywhere. A secret typed into a card never passes through a model.

**Revised (third pass):** cards on Telegram carry buttons (a URL button for connect, ✅/✖ for approvals, one per option); a message with files rides as the first file's caption; images taller or wider than 2.5:1 (full-page screenshots) or larger than 8000 px go as documents, and a photo the platform refuses is retried as a document — failures are reported instead of swallowed. A task's crew reports once, itself (the generic "✅ title" report is only for recipe-less tasks). Fixed notices ("is stuck", "needs a key", "connect") are said in the owner's language by `inOwnersLanguage`, using their own words as the sample — no word lists.

**Trade-offs:** Phrasing a notice in the owner's language costs one small model call; without a model it stays in English.

---

### 60. Services are connected from the chat

**Decision:** `connect` (`backend/assistant/connect.ts`) finds the service among installed MCP servers, known official endpoints (Notion, Linear, Sentry, Atlassian, Asana, Stripe, Vercel, Supabase, Canva) or the registry, installs it, and returns either "connected", a `connect` card with the OAuth sign-in link, or a `secret` card for a key. When the OAuth callback lands, the cards close and the chat that asked is told so it can carry on.

**Rationale:** "Connect Notion" was answered with "go to Settings → Integrations", which breaks the rule that Clopen never hands the owner homework.

**Revised (third pass):** the DB showed `notion.oauth` empty while the bot said "Notion is connected", a new sign-in link minted (and the open one dropped) each time `connect` was called, and Gmail served by a community gateway that asked for a "Smithery token" and then answered 404. Now: "connected" is only said after a check; one link per service is reused for 25 minutes; registry connectors that need a gateway's token, or local servers that need secrets, are never picked — with no safe connector the answer says to do it in the browser (Live view for a sign-in). Sign-in links return through the **callback relay** (`backend/mcp/external/oauth-relay.ts`): a server on its own port that answers only `/oauth/callback` with a state Clopen issued and has not used, put on a Cloudflare quick tunnel only while a sign-in is pending — so links work from a phone and Clopen itself is never exposed. Client registration is redone when the redirect URL changes.

**Trade-offs:** Services without an MCP server still need a custom integration or the browser. The relay needs cloudflared; without it the local callback is used.

---

### 61. Clopen's screen: two containers, a sidebar that does not change shape

**Decision:** Clopen's screen has no top bar: a left rail (Chat, Tasks, Flows, Needs you, Live view, what is running, next flows, recent chats, Stop everything), the middle view at full height, and an optional right panel — updates, or the live view of the browser an agent is using, which opens by itself when an agent takes a tab and stays closed once dismissed until another tab is taken. On a phone the panels are full-screen sheets and the views are a bottom tab bar. The sidebar brand is a mark, not a button; Clopen, Needs you and Library are rows; the project search box is gone (the command palette finds projects).

**Rationale:** The header crammed status into one line and left the right side empty; the agent asked owners to log in to a site they could not see; a logo that is secretly the home button is not discoverable.

**Revised (third pass):** the three columns, a second navigation rail and a full-height right panel were rejected. Now the sidebar lists Chat, Tasks, Needs you and Library — in the same order wide or narrow, with the brand shown once and never a control, projects as two-letter coloured avatars unique across the list (no paths; the path is the tooltip), the status dot explained on hover, and the collapse toggle in the same place at the bottom. The branch switcher shows only while a project is open. Clopen's screen is two containers like every workspace view: a list (chats and updates, or tasks) and the main view. Cards raised in the current chat sit just above the input. The live view is a card beside the chat, sized to the page's aspect ratio, foldable to a pill, shown only while an agent holds a tab. Tasks and repeating tasks share one list; a task's plan is drawn with Svelte Flow (dagre layout: left-to-right on desktop, top-to-bottom on a phone), with a "problems → fix → again" loop drawn as such, and a selected step opens its output and its agent's chat in the project.

**Trade-offs:** The live view is a polled screenshot (about 1.5 s), not a stream — enough for a login or a captcha.

---

### 62. One model per purpose, honoured everywhere, with a fallback

**Decision:** Settings → Models has four tabs: Clopen (its chat and Telegram), Specialists (agents doing crew work), Project chats (the existing default), and Background (routing, reviews, recipe decisions, and commit/branch/Library writing when those have no model of their own). The first three non-project choices live in one server-side settings row (`assistant:models`) so web and Telegram read the same value; picking a model in Clopen's chat or with `/model` saves it there. When a turn fails for a model reason (quota, auth, unavailable), it is retried once on another usable model.

**Rationale:** The old model setting picked the latest session's model over Settings, so web and Telegram disagreed, and two tabs did not explain which model did what.

**Trade-offs:** The fallback can switch to a weaker model for one turn; the turn says which model answered.

---

### 63. Short replies, and history without runs

**Decision:** Clopen's brief ends with a one-line style reminder at the tail of every turn (one or two short sentences unless asked); there is no rewrite pass and no "read more". Sessions opened by tasks, flows or the system carry an `origin` and stay out of the owner's history, as do empty chats; links are given as URLs, never local paths. Stop everything stops tasks, crews, flow runs, their agent turns, and shared links.

**Rationale:** Replies in Telegram read like reports; a second pass to shorten them costs a model call per message. The history was full of run sessions and empty chats.

**Trade-offs:** A model can still ignore the reminder now and then.

---

### 64. Tasks and flows are one thing to the owner: tasks, once or repeating

**Decision:** The UI, the command palette and Telegram show one "Tasks" list: one-off tasks (missions with a crew) and repeating tasks (flows). Telegram's `/tasks` lists both and `/flows` left the menu (still typed); the menu is seven commands. Internally they stay missions and jobs.

**Rationale:** Asked as a layperson, the owner could not tell Tasks from Flows; the only difference that matters to them is whether it runs once or again.

**Trade-offs:** "Flow" remains the word in the code, the API and the recipe docs.

---

### 65. No login means never on the internet

**Decision:** `assertMayExpose(port)` refuses any quick tunnel to Clopen's own ports (backend, dev frontend) while the auth mode is "No login"; Remote Access and `tunnel:quick:start` go through it, and `share.link` refuses Clopen's ports always (a link is for the work, not for Clopen). The OAuth callback relay is not affected: it exposes only its single callback route.

**Rationale:** With "No login", whoever reaches the URL has the machine — files, shell, every connected account. Automatic tunnels made that one click away.

**Trade-offs:** Dashboard-managed (remote) tunnels are configured in Cloudflare and cannot be checked here.

---

### 66. A follow-up continues its task; answers reach the question that waits

**Decision:** Before `delegate` starts new work it asks (a small model judgement, no word lists) whether the request continues an open or recent task from the same chat — "ok, use the defaults", "make it realistic". If so, the request answers the question that task is waiting on, or becomes a revision (`reviseRecipe`: the same crew kind, project and chats, then the same check). Before Clopen answers a message in its chat, `routeReplyToOpenCard` checks whether it answers a waiting question and passes it there. Agents inside a task cannot `owner.ask` (they choose defaults and list them) or `owner.send` (their files are kept and go out once with the result); every crew prompt says so. Crews still marked as working are resumed after a restart.

**Rationale:** The DB showed "ok" typed in the chat starting a second CV task and project while the first waited forever on a card, the same question asked twice (by the agent and by the engine), and an image sent three times (draft, "final", report).

**Trade-offs:** The follow-up judgement can misread a genuinely new request as a change; it defaults to new work when unsure. A resumed crew re-runs its recipe from the start, relying on its chats' context.

---

### 67. Results only; access asked for once

**Decision:** Clopen's replies and task reports carry the result only — never tools, steps, connectors, or that something "was sent". When an account is missing: a sign-in card when the service has one; otherwise a **login card** (email/username + password into the vault) and Clopen signs in with the browser; 2FA only when it appears; the Live view only for a captcha. An installed registry connector that answers nothing (or is a token gateway) is removed instead of being explained. A password the owner types in plain words is, once saved with `secret.save`, masked in that chat's history, search index and journal, and the owner's message is deleted from the chat app. A key is only taken from a reply to its card — never from "the next message", which once stored a complaint as a token.

**Rationale:** Asked to summarise today's email, Clopen explained a dead connector and opened a Live view instead of asking for the login; the owner's password then sat in plain text in Telegram and in Clopen's history.

**Trade-offs:** Signing in with a stored password is weaker than OAuth and breaks on new-device checks; that is what the 2FA question is for.

---

### 68. Chats see what Clopen says, and settled cards say so

**Decision:** A turn nobody typed in Clopen's chat (carrying on after a service connected, a routed reply) is delivered to every chat app conversation that is in that Clopen chat. When a card is settled anywhere, its chat message is edited in place to "✅ title" without buttons. A card answered from a chat is acknowledged with a 👍 reaction instead of "Got it.". Reminders and other routine flow messages are delivered and settled at once; Clopen's screen lists the last day's updates until cleared.

**Rationale:** Notion connected and the note was written, but the answer stayed in the web app and the Telegram card kept its "Connect" button.

---

### 69. A canvas that reads like a page, and a sidebar you size

**Decision:** The plan canvas lays steps out as a snake — four columns (one on a phone), the second row running back — with branch steps (and a check's fix) stacked under their parent and loops routed below the row, each edge label in its own place. The layout depends only on the plan's structure, so it is identical every time. A new repeating task is described in a sentence plus a "when"; Clopen drafts it (`assistant:flow-draft`), the plan is shown on the canvas, and Save keeps it; the recipe text is folded away. The sidebar's collapse button is replaced by a draggable edge (narrow enough → icon rail; double-click resets); "Needs you" is a bell in the logo row; search, tools, library, settings (and a project's workspace copies and layouts) are one row of icons; projects Clopen made for tasks sit in a folded "By Clopen" group. A project's chat greets with its avatar and name, without suggestion chips.

**Trade-offs:** Four fixed columns can leave a wide screen half empty for a short plan; fit-to-view scales it up instead.

---

### 70. Clopen's chat is one conversation, like Telegram

**Decision:** Clopen's Chat screen is a single timeline (`backend/assistant/timeline.ts`): every chat the owner had with Clopen, merged in order, showing only what was said — the owner's messages, the last words of each of Clopen's turns (never the tools in between), and what Clopen sent on its own (results, reminders, files). Topic sessions still split behind the scenes for the models; the owner never sees a seam. "Clear chat" hides history from the view (memory keeps it). A message goes in with `assistant:say`, and Clopen routes it to the right internal chat. Several messages sent within a few seconds in Telegram are merged into one turn. The Telegram menu is `/tasks`, `/stop`, `/clear`, `/help`; the rest still works from `/help`.

**Rationale:** Three messages sent in three seconds became three chats; on the web each looked like a new conversation and the earlier ones seemed to disappear. Owners want the result, not sessions.

**Trade-offs:** The timeline shows final answers only; the tool-by-tool view of a Clopen turn is no longer on its screen (a project chat still has it).

---

### 71. A quick first word, then the result

**Decision:** When a turn in Clopen's chat has not finished after 3.5 s, the Background model writes one short line that fits the message ("Oke, kucek harga BTC hari ini dulu") in the owner's language; it shows in the timeline and goes to the chat app the message came from, and the full answer follows. The "⏳ Working · tool" progress line is gone from chat apps; "typing…" remains.

**Rationale:** Answers that take a while read as not listening; tool names are process the owner does not care about.

**Trade-offs:** One small model call per slow message.

---

### 72. Telegram never goes deaf

**Decision:** A bot uses a webhook only on an address that stays (a configured domain, the browser's own address, a named tunnel). On a Cloudflare quick tunnel — which drops or changes on sleep, network change or restart — it uses long polling, which needs no address. A watchdog checks a webhook's delivery every minute and moves the bot to polling for 30 minutes when Telegram reports recent delivery errors.

**Rationale:** "Send test" worked (sending) while the bot heard nothing (receiving): the webhook pointed at a quick tunnel that had died, and nothing noticed.

---

### 73. Tasks that finish, a canvas that shows where they are, a live view you can use

**Decision:** Task criteria describe the thing itself, never its delivery (sharing comes after, by code). A reviewer passes when every criterion is met; smaller problems are notes, not failures. At most two fix rounds; a later test round re-checks only what failed and what the fix could have touched. Each agent step is stopped after 20 minutes, and stopping a run stops its agent too. Step reports are kept whole (not cut at 2,000 characters) and shown as markdown. On the canvas only the hop in progress is animated, loop steps show their latest round ("Round 2") and the loop edge says "again · round 2", steps a stopped run never reached say "Not reached", and on a phone loops route round the side. The live view draws the agent's cursor and activity, takes clicks, scrolling and typing straight on the page (no input box), and "Take over" holds the tab for the owner (`owner:` pseudo-session, never swept as an orphan) until "Hand back". Images open in a lightbox inside Clopen, never a new tab, and a result carries at most two of them. The project helper shows on hover in the wide sidebar too.

**Rationale:** A 3D weather task ran 27 minutes and kept looping because a criterion asked the tester to confirm a link "sent to the owner"; its reports looked truncated; the canvas animated every edge and showed "Done" beside a loop running again.

**Trade-offs:** The live view is frames (about 2–3 per second while in use), not the Preview panel's video stream — the stream is bound to a project's workspace.


---

### 74. One answer, everywhere, from what was saved

**Decision:** Clopen's chat is kept in a light `assistant_timeline` table (migration 089): each owner message, and per turn the last thing Clopen wrote, keyed by the message that opened the turn so a later look replaces it. It is brought up to date per chat when a message is saved and twice when a turn ends (its last words can land just after the end is announced); older chats are filled in once at startup. An answer to something typed on the web goes to every chat app that is in Clopen's conversation (not switched into a project), with no session header; delivery waits briefly until the answer is actually saved. While Clopen works, the web chat also re-fetches every few seconds. The task list carries no plans or step reports — only the opened task loads them; headers render from the list at once and only the content shows a skeleton.

**Rationale:** The last answer of a turn reached neither Telegram nor the open page until a refresh; opening Chat walked every message ever saved (a 3.7 GB database), and the task list shipped every task's full trace.

**Trade-offs:** A second copy of what was said (text only). A database created before this change needs a reset (migrations 087 and 089 were edited in place, unreleased).

---

### 75. Ask only for what is missing

**Decision:** Saving a secret answers the card that was waiting for it (by secret name, a login card's password name, or any secret card in the chat it was typed into). Clopen's brief lists the names of saved secrets and says to try the browser (it may already be signed in) and the vault before asking.

**Rationale:** A password card stayed open after the owner typed the password, and Clopen asked for a login the browser already had.

---

### 76. Repeating tasks that stop when told, and do not spam

**Decision:** Turning a flow off (or deleting it) stops a run in flight. A reminder for the same moment (±10 minutes, or the same schedule) about the same thing — judged by the Background model, no word lists — updates the existing one instead of adding another. A flow that runs more often than every 5 minutes defaults to "tell me when it changes"; its `tell` steps stay quiet when the message is the same as last time and say it in one line. Every new version of a flow says what changed: when no note was given, the Background model writes one from the before/after recipes; saving the same recipe again is not a version. Versions open as a read-only canvas with "Use this version".

**Rationale:** Four reminders for one meeting; results kept arriving after "stop"; price flows every minute sent a long message each time; versions read "Changed by Clopen" with no way to see what changed.

**Trade-offs:** One small model call per changed version, and per frequent report longer than a line.

---

### 77. A tidier chat and sidebar

**Decision:** Clopen's chat is one centred column; messages from one sender a few minutes apart group into one block with Clopen's mark at its start. Needs-you cards are neutral cards with a dismiss ✕, an inline field with Save, and "Stored encrypted" under secrets. The new repeating task form sits left of its plan canvas. Canvas edges are solid; only the hop in progress is dashed and moving. The sidebar edge resizes when dragged and folds/opens when clicked. Its footer is Search, Tools and Settings; Library moved up with Chat and Tasks; a project's workspace copies and layout are small icons on that project's row (their menus open beside it). The live view uses the Preview Browser's own agent cursor, and no screen carries "click here"-style hint lines.

**Rationale:** Owner feedback on the sixth pass: crowded footer, ragged chat, a form with empty space, a dashed-everywhere canvas, and two different agent cursors.

---

### 78. A repeating task from one sentence, drafted as data

**Decision:** The composer has one field: what should happen and when, in one sentence. The model drafts the steps as JSON (read by the forgiving `normaliseRecipe`), not recipe text; the plan is checked against the sentence by the Background model — every condition with each outcome going where the sentence says, every destination — and handed back with what is missing, up to three tries. Messages to the owner are always `Tell` (it reaches Clopen and their chat apps); other places are `Use <service>`, and a service that is not connected shows "Not connected" on the canvas and gets its sign-in or key card on Save. The recipe-text parser also reads branch markers level with their step ("Else:" under "If" like code), "Else if" chains as nested Ifs, and Case/Branch markers either way.

**Rationale:** "Redraw the plan" failed with `Line 4: could not read "Else:"`, and a sentence with "if there is mail tell me on Telegram, otherwise on Discord" was drawn as both messages in a row under "yes".

**Trade-offs:** Up to two extra model calls when a draft does not match the sentence.

---

### 79. Chat without chrome, and a live view that does not jump

**Decision:** Clopen's chat has no header and no avatars (a one-to-one chat; the sidebar names it); clearing is a small floating icon. Empty, the greeting and the input sit together in the middle; the input matches the project chat's (send-horizontal, stop). The live view floats over the right of the chat and slides in, so the centred chat never moves; when the agent lets go the last frame stays marked "Done", folds to a pill after 4 s and goes after 30 s. The page is drawn in the Preview Browser's device mockup, fitted to the card on a dotted backdrop, with that panel's agent cursor drawn unscaled. Plan canvases use the same visible dots. The sidebar footer is Settings · Tools · Library · Search, and the narrow rail's top icons share the footer's colour.

**Rationale:** Owner feedback: off-centre header text, empty space, too many Clopen marks on a phone, a live view that pushed the chat aside and vanished abruptly, and a tall phone page drawn at full height.

---

### 80. Chats the owner opens; Clopen never splits one on its own

**Decision:** Clopen has chats: Main, plus any the owner opens (named by their first message until renamed). A chat is one conversation on the web and in every Telegram chat that is in it — all of them are the owner's own devices. Underneath, a chat is a line of sessions; a fresh one continues it only when the last grew too long, carrying a context capsule. Topic guessing and "busy → parallel session" are gone: a message sent while Clopen works waits in the same chat (the composer queues it), and a change to running work goes to that task (follow-ups now consider recent tasks from any chat, not only the same session). Telegram: a chat is in the Clopen chat its current session belongs to; `/chats` lists them as buttons, with "New chat". What is typed in one place appears in the others ("💻 …" from the web, "📱 …" from another chat app) before its answer, and the answer goes to every chat app in that chat. Reports go to the chat whose turn started the task (all chat apps when none is in it, with the chat's name). Chats live in settings (`assistant:chats`, `assistant:chat-sessions`); sessions no chat claims are Main's.

**Rationale:** One sorted afternoon split into eight hidden sessions: "no, send it to Notion instead" and "ya, saya Arga" were cut off from what they answered, a correction ("make it 8-bit") became a second task that rebuilt the app from scratch, and the web and Telegram each pointed at a different session, so answers arrived without their question.

**Trade-offs:** A message sent while Clopen is busy waits for the turn to end.

---

### 81. Secrets by name, files by download

**Decision:** A saved secret never goes through a model. The browser `type` action takes `secret: "<name>"`; terminal commands take `{{secret:name}}`; both are filled in on this machine. `secret.get` says how to use a secret and no longer returns its value; every agent-action and browser report is masked against the vault before a model reads it. Values that reached the history earlier are scrubbed once, in slices, in the background. The browser has a `download` action that keeps the file in the project's `downloads/` folder and returns its path (the host bridge keeps the next download for the agent instead of only relaying it to a viewer); share links are for showing built things, never for moving files. A result always carries its documents; only pictures are capped at two.

**Rationale:** Signing in to a mailbox sent the password through the model and stored it in plain text in seven tool calls; downloading an attachment took 19 minutes and ended with a private PDF moved through a public tunnel; a signed PDF was dropped from its result because the two screenshots came after it.

---

### 82. Smaller fixes from reading the Telegram chat

**Decision:** The timeline treats a user message that only carries tool results as part of the turn (process lines no longer show as answers; the table is rebuilt once on revision 2). A reply to a deleted message (a password Clopen removed) goes out as a plain message instead of being refused and lost. A message that calls something off ("never mind, Notion instead") closes the cards it made pointless — a model judges, along with whether it answers a waiting question. A login card in Telegram asks for each field as its own message. Optional browser fields accept null and `wait` with text runs as `wait_for`, so a batch is not rejected over either; agent actions accept common argument aliases (`content` for `body`). A connector that is not the service's own needs the owner's approval, naming its publisher. Loop edges on the canvas go round the side when they return to the step above, underneath otherwise. Notices fall back to the owner's last words for their language (the `/start` reply included), and answer delivery to chat apps is logged.

---

### 83. What the owner says shows everywhere at once

**Decision:** A message the owner sends — from Telegram or the web — is shown on every open screen of that chat and mirrored to the owner's other chat apps the moment it arrives (`assistant:owner-said`), not after Telegram's burst window, a queue behind a busy turn, or the answer; its timeline row replaces it once the turn takes it (pieces of a burst count as arrived when the merged row holds them). Attachments are listed by name with a count — five photos from Telegram are all "photo.jpg", which crashed the chat when names were used as keys. The chat has floating, round controls: the chat it is (with the others and "New chat") on the left, new chat and clear on the right; the sidebar's "+" for a new chat is always shown.

**Rationale:** A message typed on Telegram appeared on the web only seconds later, or after Clopen answered; an album of photos broke the chat screen; the new-chat button only appeared on hover.

---

### 84. One source for each thing the owner says, sees and chooses

**Decision:** Most of the sync bugs came from the same logic living in several places. Each now has one:
- **What the owner says** is one `assistant_timeline` row, written the moment it arrives (web or Telegram) under the id its prompt is saved with, grown in place while an album or a burst comes in, and kept through resyncs (source, kept photos, an edit, the arrival time). Screens never guess a message from its pieces; photos the owner sent are kept and shown.
- **Which chat is open** is one pointer for every place: switching on the web switches Telegram (with a one-line note) and `/chats` switches the web. Answers from a chat that is not open still reach Telegram, named.
- **A card closes** one way (`cancelCards`/`settle`), so the web, Telegram and anything waiting on it all hear — bulk SQL dismissal is gone. Cards show above the input of their own chat only. A card's answer appears as the owner's own (masked) words, on the web and in Telegram; a message that answers a card never gets a second turn.
- **Model per job** is one list (`purposes.svelte.ts`): Clopen, Specialists, Project chats, Background, Commit messages, Library writer, Memory writer — each with its fallback (writers → Background → Clopen; Specialists → Project chats). One Models page and the same row in Git and Memory; the server follows the same chain (the memory writer falls back to Background). Engine choice is compact chips.
- **Follow-ups** are explicit: `delegate` takes `continues: <taskId>` (the brief lists recent tasks); the guesser counts a style change as a change, not new work.

**Rationale:** Telegram and the web showed different chats and split messages; "make it 8-bit" and "now 3D" became new tasks; cards lingered after their task was cancelled and showed in every chat; model settings lived in four stores with three fallbacks.

**Trade-offs:** The storage of each model job stays where its readers already look (assistant row, user settings, memory config); the list is the one place that defines them.

---

### 85. One Telegram, edits as corrections, a bot that comes back by itself

**Decision:** Clopen has one owner and one linked Telegram chat; linking another replaces it. In Clopen's chats an edit is a correction — nothing branches or is deleted: still in the burst window or queued, the words change; being answered, that answer stops and the new words are answered; answered, the row shows "edited" and Clopen hears the change and acts on it (redo, or change the task). The web has an edit button on the owner's messages; a web edit also edits its mirror in Telegram. Project chats keep their branch-and-checkpoint edit. A message sent while Clopen is busy waits in the same chat and gets a quick word in the owner's language instead of "your message is queued". A message that never got a turn (sent while Clopen was starting) is retried once after 90 s. A bot that fails or loses its connection is retried after 5 s, 15 s, 30 s, then every minute; a polling bot is health-checked each minute; Settings shows the countdown and a Reconnect button.

**Rationale:** A Telegram edit replied "Only messages you sent from this chat can be edited", a "Halo" went unanswered after a restart, and a dropped connection needed a server restart.

---

### 86. Tasks from outside, and smaller fixes

**Decision:** Each repeating task can have a webhook — a long secret URL (replaceable, 10 runs a minute) whose request body becomes the run's context. Card titles are one plain line (a pasted report goes to the body, markdown removed); chat apps get a short body. A launch (Marketer, "publish?" card) is planned only when the owner's own words ask to publish. Fixed Telegram replies are worded in the owner's language. Step details slide up with tabs (Result, Instructions, Rounds, Info), render a review as passed/issues instead of JSON, can be enlarged, and the canvas camera keeps the selected step in view. The sidebar's resize grip sits in the gutter like the panel splitters; the chat list left the sidebar (the chat switcher has it, animated); on a phone every row closes the menu, projects are compact rows, Tools and Worktree menus fit the screen, and "New project" is a folder icon. Settings texts were cut to one line each and stale cross-links removed.

---

### 87. One chat record for web and Telegram, running steps from the run, a free model per job

**Decision:**
- **The timeline table is the chat.** Clopen's quick word ("Oke, diganti jadi 8-bit sekarang.") is now a row, `ack:<message id>`, written once. The web shows it, a refresh keeps it, and Telegram gets it as a reply to the message it answers, not to the turn that was running. It used to be a web-only event plus a separate Telegram send.
- **Answers stay with their own turns.** A turn is re-read from the message time of the last owner row that has a turn, never from the row's receipt time. A message that waited behind a busy turn is saved later than it arrived, and reading from the arrival time keyed the previous turn's answer to the wrong message.
- **A replaced crew run touches nothing.** A crew run owns its task only while it is the run registered for it. A run that was stopped (paused, or replaced because the task changed mid-way) no longer writes the trace or the status. Before this, the replaced run set an active task to "paused" while the new crew kept working.
- **Running steps come from the engine.** The engine reports which steps are under way (`live-steps.ts`, counted per path). Tasks and flows expose them as `runningSteps`, and the canvas marks those steps instead of guessing the next one. Progress writes keep the last update instead of dropping it.
- **Every job has its own model, defaulting to the free one.** There is no "Same as …" chain. The server does the same: Background, Specialists and the memory writer use their own model or the free model. Git and Memory show a link to the job's row in Models instead of a second picker.
- **Telegram is one account.** Linking is offered only while none is linked, and "Disconnect" frees the slot.
- **UI changes:**
  - The new repeating task screen:
    - redraw sits with its sentence and appears only after the sentence changes;
    - the steps-as-text box is gone;
    - steps open from the canvas like any plan, and their words can be edited there with the canvas following.
  - The Tasks list width is dragged at the gap.
  - The live view floats over the chat; it can be moved and resized, and its place is kept.
  - The sidebar Chat row has no "+".
  - Engine choice in Agents is compact chips.
  - On a phone:
    - projects have a separator, tighter rows and a grip to reorder;
    - a long press on a message opens Edit and Copy.

**Rationale:**
- After a refresh the web lost the quick word and showed answers under the wrong message, while Telegram kept everything.
- A changed task looked stuck on "Waiting" and then ended up paused.
- "Same as Background · Not set" hid which model a job actually used.

**Trade-offs:**
- Running steps live in memory: after a restart a resumed crew shows them again from its next step.
- The free model is the same for every job until the owner picks one. Specialists on a free model are slower than on a strong one, which the row's description says.
- This supersedes the fallback chain in #84.
