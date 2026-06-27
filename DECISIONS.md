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
**Rationale:** Bidirectional communication required for chat, terminal input, file operations, and browser preview interaction. Room-based architecture enables project isolation and collaboration.
**Trade-offs:** More complex state management, reconnection logic required.

---

### 4. SQLite for Local Storage

**Decision:** SQLite instead of PostgreSQL or other databases
**Rationale:** No separate server needed, file-based storage ideal for local app, easy backup and portability, good performance for single-user and small team use.
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

## Authentication & Collaboration

### 19. Flexible Authentication (No-Auth + Multi-User)

**Decision:** Dual authentication mode — No Login or With Login (token-based) — configurable during setup wizard and togglable in Settings → Security
**Rationale:** Not all deployments need authentication. Personal/local use should be frictionless (No Login), while team/production deployments need access control (With Login). The system stores `authMode` in `system:settings` (`'none'` or `'required'`). In No Login mode, a default admin user is auto-created and all WS routes bypass authentication checks. Existing users and sessions are preserved when switching modes (bypassed, not deleted). Switching from No Login to With Login generates a PAT for the existing admin. Three token types remain for With Login: session (`clp_ses_*`, 30-day, auto-reconnect), PAT (`clp_pat_*`, permanent, cross-device login), invite (`clp_inv_*`, single-use). Rate limiting, admin-only routes, and CLI `clopen reset-pat` recovery all apply in With Login mode.
**Trade-offs:** No Login mode has no access control, admin must be aware when exposing via tunnel. UI sections (user management, invites, PAT settings) are hidden in No Login mode to avoid confusion.

---

### 20. Real-Time Presence Tracking

**Decision:** WebSocket-based presence tracking per project
**Rationale:** Show active collaborators, enable awareness in shared sessions, foundation for future cursor sharing.
**Trade-offs:** Presence state lost on disconnect.

---

## Infrastructure

### 21. Cloudflare Tunnel Built-In

**Decision:** Built-in Cloudflare Tunnel support; the `cloudflared` binary is installed on demand from **Settings → System Tools** (not auto-downloaded on first tunnel use).
**Rationale:** One-click public URL with HTTPS, no port forwarding needed, works across networks and firewalls, QR code for mobile access. Routing the binary install through System Tools gives admins explicit, audit-able control and mirrors how Git/Claude Code/OpenCode/Chrome are managed.
**Trade-offs:** Requires internet access, dependent on Cloudflare availability. Public Tunnel now fails with a "install cloudflared" prompt until an admin installs it once.

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

**Decision:** Replace single-page admin setup with a multi-step wizard (auth mode → admin account → AI engines → preferences)
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
**Rationale:** Clopen runs across wildly different environments — desktop GUI launches (macOS/Linux), terminal launches, systemd services, Docker/Railway containers, Windows. The previous approach (spawning the user shell) was only correct for one of these; in containers it always failed (`$SHELL` unset, `userInfo().shell === "unknown"`), producing spam warnings and a wasted 2s per status call. Known-dirs is deterministic, cross-platform, and covers both the System Tools installer targets and the common locations users install CLIs themselves. Existing-dir checks happen every call so newly-installed tools appear without a restart.
**Trade-offs:** The known-dirs list must be maintained when new install locations enter common use. Users with truly custom PATH entries in rc files (not on the list) on non-desktop environments won't be discovered — acceptable because the shell-harvest fallback still covers that case on desktops where `$SHELL` is valid.

---

### 32. System Tools Installer (Server-side)

**Decision:** Admin-only **Settings → System Tools** section installs Git, Claude Code, OpenCode, Codex, Copilot, Qwen Code, Chrome, and Cloudflared via a server-side recipe registry (`backend/engine/install-recipes.ts`, `ToolId = 'git' | 'claude' | 'opencode' | 'copilot' | 'codex' | 'qwen' | 'chrome' | 'cloudflared'`). Chrome uses `@puppeteer/browsers install chrome@stable` on macOS/Windows for a self-contained Chrome for Testing binary. On Linux x86_64 it installs Google Chrome directly from Google's own channels (`.deb` from `dl.google.com` via `apt-get install` on apt, and the `.rpm` URL via `dnf install` / `zypper install` on dnf/zypper) so system library dependencies (libatk, libnss3, …) auto-resolve via the distro package manager and Google's postinst registers an apt repo for future updates. Platforms without an official Google Chrome package (pacman, apk, Linux arm64) are marked non-auto-installable and surface manual instructions — clopen does not fall back to chromium so the runtime stays a single known build. Each install runs through `backend/engine/install-runner.ts`, which spawns the recipe via `Bun.spawn`, streams stdout/stderr line-by-line over WebSocket (`system-tools:install-stream`), buffers output in a bounded ring buffer (so late subscribers can catch up), and supports cancellation. Output renders client-side in xterm.js so ANSI escapes and `\r`-based progress bars display correctly. After a successful install, the runner re-enriches PATH so downstream code paths (e.g. `models:list` → `Bun.which('opencode')`) immediately see the new binary without a process restart.
**Rationale:** Asking admins to drop into a terminal to install dependencies is friction, especially for non-developer admins running clopen as a managed workspace. Recipes are server-only (clients can only pick a tool id) so the client cannot supply arbitrary commands. Privilege detection (`backend/utils/privilege.ts`) determines whether sudo/admin is available and selects the right recipe variant per platform; tools that require interactive elevation (e.g. apt-get with sudo on a non-elevated server) are marked non-auto-installable and surface manual instructions instead.
**Trade-offs:** Recipe coverage must be maintained per platform/package-manager; non-admin platforms surface manual instructions only. The post-install PATH enrichment assumes the installer wrote into either a known install directory or a directory already present in the enriched PATH; otherwise the user must add the binary to PATH manually.

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

**Decision:** Built-in database client lives in `backend/db-client/`. A single `ConnectionManager` (singleton) owns a `Map<connectionId, ConnectionEntry>`; each entry holds a `DbClientDriverAdapter`, an optional `SshTunnel`, and a `lastUsedAt` timestamp. Five drivers ship as separate adapters implementing a common `DbClientDriverAdapter` contract: `MysqlAdapter`, `PostgresAdapter`, `SqliteAdapter`, `MongoDbAdapter`, `RedisAdapter`. Each driver uses the ecosystem's native client (`mysql2`, `pg`, `bun:sqlite`, `mongodb`, `ioredis`) — no ORM. SSH tunneling uses `ssh2.Client` — `openSshTunnel()` opens a local TCP listener on an ephemeral port, forwards each accepted socket via `client.forwardOut`, and the adapter connects to `127.0.0.1:<localPort>` instead of the remote host:port. Connections idle longer than 10 minutes are swept by a 1-minute interval and disposed (timer is `unref()`-ed so it never blocks shutdown). All client-facing surface is WebSocket (`backend/ws/db-client/`): `connections` (CRUD), `schema`, `structure`, `query`, `io` (import/export), `access` (per-connection scoped guard). Scoped access guards (introduced in commit `7c60bc6`) gate every mutation behind owner/admin checks via migration `035_add_owner_to_db_client_connections.ts`. Shared types under `shared/types/db-client/`. Frontend stores in `frontend/stores/features/db-client.svelte.ts`.
**Rationale:** A driver-per-engine pattern mirrors the AI engine adapter pattern already in the codebase — adding a new database engine is a self-contained change behind a stable contract. Native drivers are non-negotiable: an ORM would either require a schema definition (impossible since users connect to arbitrary databases) or produce generic SQL that loses driver-specific features (Postgres `EXPLAIN ANALYZE`, MySQL `SHOW CREATE TABLE`, MongoDB aggregation, Redis cluster commands). The connection manager is in-process and singleton because every WS message for a connection must reuse the same live socket — a fresh connect-per-query would burn TLS handshakes and drown low-quota cloud DBs. Idle eviction with `unref()` keeps long-running clopen instances tidy without preventing shutdown. SSH tunneling via `ssh2` was prototype-verified end-to-end in PHASE 0 (`test-ssh-mysql.ts`) before integrating.
**Trade-offs:** Five driver dependencies in the bundle (Postgres + MySQL + Mongo + Redis + ssh2) — only loaded lazily when a connection of that driver actually opens, so the cold-start cost is bounded. Native drivers means each engine's quirks (Postgres binary protocol, MySQL packet sizes, MongoDB BSON, Redis pipelining) must be handled per-adapter. SSH tunnel uses password / private-key auth only (no agent forwarding yet). Plaintext credentials are stored in SQLite alongside the rest of the workspace data — same threat model as engine OAuth tokens.

---

### 37. Per-Engine Config-Dir Isolation (`{clopenDir}/engine/{engine}/user/`)

**Decision:** Every engine's CLI/SDK home dir is redirected out of the user's global location (`~/.codex`, `~/.copilot`, `~/.config/opencode` + `~/.local/share/opencode`, `~/.qwen`) into `{clopenDir}/engine/{engine}/user/` so Clopen never mixes with the user's own standalone CLI usage. The `engine/` parent groups all AI-engine state in one place, separate from Clopen's other data dirs (`{clopenDir}/snapshots/`, the DB). One helper — `getEngineUserConfigDir(engine)` in `backend/utils/paths.ts` — is the single source of truth, mirroring how Claude was already isolated via `CLAUDE_CONFIG_DIR`. Levers per engine: Codex `CODEX_HOME` (set in `credential.ts` + the SDK `env` in `stream.ts` + the `codex login` PTY env), Copilot `baseDirectory` (SDK forwards it as `COPILOT_HOME`), Qwen `QWEN_RUNTIME_DIR` (env + the `session-fork.ts` base), OpenCode `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` on the spawned `opencode serve` env. OpenCode additionally guards server reuse on a persisted data-dir key (`opencode.server.datadir`) so a server spawned with a stale/global dir is never reused — it respawns into the correct isolated dir. **No migration from the user's global dirs** (forward-only — see Trade-offs), but migration `043_relocate_engine_config_dirs.ts` does relocate Clopen's *own* earlier isolated layout (`{clopenDir}/{engine}/user/`, pre-`engine/`-parent) to the current path — safe because it only touches Clopen-created dirs, never the engine's global home. See `backend/engine/docs/lessons-learned.md` §9.19.
**Rationale:** Mixing Clopen's sessions/credentials/logs into the user's global dotfiles is invasive and surprising — it pollutes the user's own CLI history and risks Clopen and standalone usage clobbering each other's state. A single isolated dir per engine (shared across all of that engine's Clopen accounts) keeps session memory + fork-by-copy intact while the per-account auth-blob swap (Decision #33, §9.13) still handles multiple accounts inside it. No-migration was chosen deliberately: credentials live in the DB and re-materialize automatically, and the two shared-SQLite engines (Copilot `session-store.db`, OpenCode monolithic `opencode.db`) interleave Clopen and standalone sessions in one file with no safe per-session extraction — so copying would either drag in the user's private global sessions or risk DB corruption.
**Trade-offs:** Conversations created before this change lose engine-side resume continuity (their session/rollout files stay in the old global dir); the message history in Clopen's own DB is unaffected and still renders, but continuing an old chat starts a fresh engine session. Codex's SDK does **not** inherit `process.env` when `env` is passed, so the adapter must forward the full `getCleanSpawnEnv()` plus `CODEX_HOME`. Qwen isolation is partial — `QWEN_RUNTIME_DIR` relocates runtime output but the CLI's global `settings.json` still resolves to `~/.qwen` (no env override); harmless because Clopen uses paste-token auth. OpenCode follows XDG and namespaces under an extra `opencode/` segment, so its state lands at `{clopenDir}/engine/opencode/user/opencode/` (one level deeper than the other engines) — there is no supported env var to flatten it.

---

### 38. External MCP servers proxied through the bridge (`/mcp/ext/<slug>`)

**Decision:** User-installed (external) MCP servers are no longer connected directly by each engine. Each enabled server gets its own endpoint `GET/POST/DELETE /mcp/ext/<slug>` on the same Streamable-HTTP bridge the internal `clopen-mcp` tools use (`backend/mcp/external/proxy.ts`, routed in `backend/index.ts`, lifecycle in `backend/mcp/internal/remote-server.ts`). Clopen connects to the real upstream (stdio subprocess or remote URL) as an MCP **client** and re-exposes its tools there. Every per-engine builder in `backend/mcp/external/config.ts` now emits the **identical** shape — a loopback bridge URL plus the in-memory service-token header — regardless of the upstream's real transport; the SDK config key is the only per-engine difference (Qwen `httpUrl`, Codex `http_headers`, Copilot `tools:['*']`, etc.). The proxy reads upstream `tools/list` with a **raw** JSON-RPC request (bypassing `Client.listTools()`), **drops each tool's `outputSchema`**, and repairs dangling `$ref`s in `inputSchema` before re-serving. Upstream OAuth/API-key credentials are injected once by the proxy (`resolveServerRow`); the engine→bridge hop only carries the service token. The upstream client (and any stdio subprocess) is created lazily per bridge session and torn down on session close.

**Rationale:** Engines discover tools via the MCP SDK's `Client.listTools()`, which eagerly compiles an Ajv validator for every tool's `outputSchema`. A single unresolvable `$ref` (Stitch ships `#/$defs/ScreenInstance`) makes that throw; the engine CLIs' `discoverTools` swallow the error and surface **zero** tools while still reporting the server "connected" — which silently hid all remote-server tools on Qwen and all external tools on Copilot, even though the servers connected. Owning the upstream client lets Clopen read schemas leniently and sanitise them, so one malformed schema can no longer take down a whole server. Routing through the existing bridge (rather than a new listener — see §9.12) also unifies stdio and remote into one shape per engine, centralises credential handling, and makes the Settings `mcp:status` probe truthful (a server only works end-to-end when its tools are actually serveable). Verified end-to-end: a default-Ajv client that crashed connecting straight to Stitch returns all 14 tools through the proxy.

**Trade-offs:** External stdio subprocesses now run in Clopen's process tree (per bridge session) instead of the engine's — consistent with how internal tools execute, but Clopen owns their lifecycle. Codex's per-tool `approval_mode` auto-approval still can't be set for external tools (names are unknown when the synchronous builder runs), so non-interactive `codex exec` may cancel external MCP calls — unchanged by the proxy. `outputSchema` is dropped wholesale rather than validated, so engines that consume structured tool output lose it for external tools; non-Claude engines don't rely on it and the alternative (crashing the whole server) is worse.

---
