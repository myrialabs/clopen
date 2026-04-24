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

**Decision:** Adapter pattern for AI engines, all normalizing output to a unified message format (`shared/types/unified`)
**Rationale:** Frontend and stream manager remain engine-agnostic. Each engine evolves independently. Per-project engine isolation prevents cross-project state leaks. Type system is centralized in `shared/types/unified/` — no coupling to any specific SDK's message format.
**Trade-offs:** Added abstraction layer, OpenCode requires a background server process.

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
**Rationale:** Developers need multiple accounts (personal/work/team). Tokens injected via `CLAUDE_CODE_OAUTH_TOKEN` env override, isolated under `{clopenDir}/claude/user/` without touching system-level Claude config. `clopenDir` is `~/.clopen-dev` in development, `~/.clopen` in production.
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

**Decision:** Dual authentication mode — No Login or With Login (token-based) — configurable during setup wizard and togglable in Settings > Security
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

**Decision:** Built-in Cloudflare Tunnel support
**Rationale:** One-click public URL with HTTPS, no port forwarding needed, works across networks and firewalls, QR code for mobile access.
**Trade-offs:** Requires internet access, dependent on Cloudflare availability.

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

**Decision:** Admin-only **Settings → System Tools** section installs Git, Claude Code, OpenCode, and Chrome via a server-side recipe registry (`backend/engine/install-recipes.ts`). Chrome uses `@puppeteer/browsers install chrome@stable` on macOS/Windows for a self-contained Chrome for Testing binary. On Linux x86_64 it installs Google Chrome directly from Google's own channels (`.deb` from `dl.google.com` via `apt-get install` on apt, and the `.rpm` URL via `dnf install` / `zypper install` on dnf/zypper) so system library dependencies (libatk, libnss3, …) auto-resolve via the distro package manager and Google's postinst registers an apt repo for future updates. Platforms without an official Google Chrome package (pacman, apk, Linux arm64) are marked non-auto-installable and surface manual instructions — clopen does not fall back to chromium so the runtime stays a single known build. Each install runs through `backend/engine/install-runner.ts`, which spawns the recipe via `Bun.spawn`, streams stdout/stderr line-by-line over WebSocket (`system-tools:install-stream`), buffers output in a bounded ring buffer (so late subscribers can catch up), and supports cancellation. Output renders client-side in xterm.js so ANSI escapes and `\r`-based progress bars display correctly. After a successful install, the runner re-enriches PATH so downstream code paths (e.g. `models:list` → `Bun.which('opencode')`) immediately see the new binary without a process restart.
**Rationale:** Asking admins to drop into a terminal to install dependencies is friction, especially for non-developer admins running clopen as a managed workspace. Recipes are server-only (clients can only pick a tool id) so the client cannot supply arbitrary commands. Privilege detection (`backend/utils/privilege.ts`) determines whether sudo/admin is available and selects the right recipe variant per platform; tools that require interactive elevation (e.g. apt-get with sudo on a non-elevated server) are marked non-auto-installable and surface manual instructions instead.
**Trade-offs:** Recipe coverage must be maintained per platform/package-manager; non-admin platforms surface manual instructions only. The post-install PATH enrichment assumes the installer wrote into either a known install directory or a directory already present in the enriched PATH; otherwise the user must add the binary to PATH manually.

---
