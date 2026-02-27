# Technical Decisions Log

This document tracks all major technical decisions made during the development of Clopen.

---

## Architecture Decisions

### 1. Bun.js as Runtime

**Decision:** Use Bun.js instead of Node.js
**Rationale:**

- Better performance for CLI spawning and WebSocket connections
- Native TypeScript support without transpilation
- Faster package installation and startup times
- Built-in test runner and bundler
- Modern tooling and excellent developer experience

**Implementation:**
- All scripts use Bun as runtime
- Native Bun APIs for file operations and process management
- Updated all shebangs to `#!/usr/bin/env bun`

**Trade-offs:**
- Less mature ecosystem compared to Node.js
- Potential compatibility issues with some npm packages
- Team members need to install Bun.js

**Result:**
- ~3x faster dependency installation
- Improved startup times for development server
- Simplified build process
- Zero Node.js dependencies in development workflow

---

### 2. Separate Frontend/Backend Architecture

**Decision:** Use separate frontend and backend with WebSocket communication
**Rationale:**

- Better separation of concerns
- Frontend (Svelte 5 + Vite) focuses on UI/UX
- Backend (Bun + Elysia) handles Claude integration, file operations, terminal
- WebSocket provides real-time bidirectional communication
- Enables future mobile app development

**Implementation:**
- Backend: Elysia framework with WebSocket support
- Frontend: Svelte 5 with Vite for development
- Single port (9141) for both HTTP and WebSocket
- Development: Vite embedded as middleware (no separate port)

**Trade-offs:**
- More complex setup than monolithic architecture
- Need to manage WebSocket connection state

**Result:**
- Clean separation enables easier maintenance
- Real-time updates across all clients
- Foundation for collaboration features

---

### 3. WebSocket for Real-Time Communication

**Decision:** Use native WebSocket instead of Server-Sent Events (SSE)
**Date:** 2026-08-22
**Rationale:**

- **Bidirectional Communication:** WebSocket enables client-to-server messages (needed for chat, terminal input, file operations)
- **Real-Time Collaboration:** Multiple users can interact with same project simultaneously
- **Terminal Streaming:** PTY output requires continuous bidirectional stream
- **Browser Preview Control:** Client needs to send interaction events to server
- **Efficient:** Single persistent connection instead of multiple HTTP requests

**Implementation:**
- Elysia WebSocket plugin with room-based architecture
- Backend: `backend/lib/utils/ws.ts` (WSServer singleton)
- Frontend: `frontend/lib/utils/ws.ts` (WSClient singleton)
- Shared utilities: `shared/utils/ws-client.ts` and `shared/utils/ws-server.ts`
- Room-based architecture for project isolation
- Per-connection state tracking for user presence

**Architecture:**
```
Client 1 ─┐
Client 2 ─┼─> WebSocket Server ─> Project Room ─> Broadcast to all clients
Client 3 ─┘                         (per-project)
```

**Key Features:**
- Automatic reconnection with exponential backoff
- Room-based broadcasting for project-specific events
- Direct connection targeting for user-specific events (terminal, chat streaming)
- Presence tracking for collaboration
- Stale connection cleanup

**Trade-offs:**
- More complex state management than SSE
- Need to handle reconnection logic
- Requires WebSocket support in deployment environment

**Result:**
- Real-time collaboration works seamlessly
- Terminal and chat streaming are reliable
- Foundation for future real-time features

---

### 4. SQLite for Local Storage

**Decision:** Use SQLite instead of other databases
**Rationale:**

- No separate database server needed
- File-based storage perfect for local application
- Good performance for single-user and small team use
- Easy backup and portability (single file)
- Excellent tooling and mature ecosystem

**Implementation:**
- Custom migration system in `backend/lib/database/migrations/`
- Connection pooling for concurrent operations
- Comprehensive schema with relations
- Support for collaborative features

**Trade-offs:**
- Limited concurrent write capabilities (not an issue for typical usage)
- No built-in replication (planned for future)

---

## Framework-Specific Decisions

### 5. Svelte 5 with Runes System

**Decision:** Use Svelte 5 with new runes system
**Rationale:**

- More explicit and predictable reactivity
- Better TypeScript integration
- Improved performance with fine-grained reactivity
- Modern component architecture
- Smaller bundle sizes than React/Vue
- Future-proof with Svelte's direction

**Implementation:**
- `$state()` for reactive state
- `$derived()` for computed values
- `$effect()` for side effects
- `$props()` for component props
- Function-based components

**Trade-offs:**
- Learning curve for new runes syntax
- Breaking changes from Svelte 4
- Smaller ecosystem compared to React/Vue

---

### 6. Elysia as Backend Framework

**Decision:** Use Elysia instead of Express or Fastify
**Rationale:**

- Built specifically for Bun runtime
- Native TypeScript support with type inference
- Built-in WebSocket support
- Excellent performance
- Modern API design
- Plugin system for modularity

**Implementation:**
- Main server in `backend/index.ts`
- WebSocket router in `backend/ws/`
- Middleware for CORS, error handling, logging

**Trade-offs:**
- Newer framework with smaller ecosystem
- Less community resources compared to Express

---

### 7. Tailwind CSS v4

**Decision:** Use Tailwind CSS v4 with CSS-first configuration
**Rationale:**

- CSS-first configuration eliminates JavaScript config files
- Native CSS variables for theming
- Up to 100x faster incremental builds
- Container queries support
- Automatic content detection
- Modern CSS features (cascade layers, registered properties)

**Implementation:**
- CSS configuration in `frontend/app.css`
- Theme variables defined with CSS custom properties
- No `tailwind.config.js` needed

**Trade-offs:**
- Requires modern browsers (Safari 16.4+, Chrome 111+, Firefox 128+)
- Breaking changes from v3 require migration
- Learning curve for CSS-first approach

---

## Integration Decisions

### 8. Engine-Agnostic Adapter Architecture

**Decision:** Implement an adapter pattern for AI engines so the backend is not tied to Claude Code only
**Date:** 2026-02-26
**Rationale:**

- Users want to choose between Claude Code and OpenCode
- Stream manager and frontend should be engine-agnostic
- Each engine can evolve independently without affecting the rest of the system
- Per-project engine isolation prevents cross-project state leaks

**Implementation:**
- Engine registry/factory: `backend/lib/engine/index.ts`
- Shared interface: `backend/lib/engine/types.ts`
- Claude Code adapter: `backend/lib/engine/adapters/claude/`
- OpenCode adapter: `backend/lib/engine/adapters/opencode/`
- All adapters normalize output to Claude SDK message format (`SDKMessage`)
- Two tiers:
  - Global singletons (`getEngine`) for non-streaming operations (models list, settings)
  - Per-project instances (`getProjectEngine`) for streaming — fully isolated abort controllers and session IDs

**Architecture:**
```
Stream Manager
      │
  ┌───┴───┐
  ▼       ▼
Claude  OpenCode
Engine  Engine
```

**Trade-offs:**
- Added abstraction layer over direct SDK calls
- OpenCode requires a background server process

**Result:**
- Frontend and stream manager are completely engine-agnostic
- Switching engines does not require frontend changes
- Clean separation for future engine additions

---

### 8a. Claude Agent SDK for Chat (Claude Engine)

**Decision:** Use Claude Agent SDK inside the Claude Code engine adapter
**Rationale:**

- Official SDK from Anthropic
- Built-in streaming support
- Comprehensive tool use handling
- Session management
- Type-safe TypeScript API

**Implementation:**
- Claude adapter: `backend/lib/engine/adapters/claude/`
- Stream manager: `backend/lib/chat/stream-manager.ts`
- WebSocket streaming: `backend/ws/chat/stream.ts`

**Trade-offs:**
- Dependency on Anthropic's SDK updates

---

### 9. bun-pty for Terminal

**Decision:** Use bun-pty instead of node-pty
**Rationale:**

- Native Bun implementation
- Better performance with Bun runtime
- Full PTY emulation support
- Cross-platform compatibility (Windows, macOS, Linux)
- Maintained specifically for Bun ecosystem

**Implementation:**
- PTY manager: `backend/lib/terminal/pty-manager.ts`
- Session manager: `backend/lib/terminal/pty-session-manager.ts`
- WebSocket streaming: `backend/ws/terminal/stream.ts`
- Multi-tab support with session persistence

**Trade-offs:**
- Smaller community than node-pty
- Fewer resources and examples

---

## New Feature Decisions

### 29. Built-in Git Management (Source Control)

**Decision:** Implement a full source control panel using native git CLI instead of a library
**Date:** 2026-02-26
**Rationale:**

- **Feature Parity:** Users need git operations without leaving Clopen
- **Completeness:** Staging, commits, branches, remote ops, stash, conflict resolution
- **Reliability:** Direct git subprocess calls are always in sync with actual repo state
- **No Extra Deps:** No need for libgit2 bindings or heavy git library

**Implementation:**
- Git executor: `backend/lib/git/git-executor.ts` — subprocess wrapper
- Git parser: `backend/lib/git/git-parser.ts` — parses porcelain output
- Git service: `backend/lib/git/git-service.ts` — high-level operations
- Shared types: `shared/types/git.ts`

**Supported Operations:**
- Status (staged/unstaged/untracked/conflicted)
- Stage/unstage files individually or all at once
- Discard changes (tracked: checkout, untracked: delete)
- Commit and amend commit
- Diff (unstaged, staged, by commit, between refs)
- Branches (list local + remote, create, switch, delete, rename, merge)
- Ahead/behind tracking vs upstream
- Remote (list, fetch, pull, push with -u, add, remove)
- Log with pagination and total count
- Stash (list, save, pop, drop)
- Conflict resolution (ours/theirs/custom content + auto-stage)

**Trade-offs:**
- Requires git installed on host machine
- Parsing porcelain output must be kept in sync with git version changes

**Result:**
- Complete VS Code-like source control panel in the browser
- No external git library dependency

---

### 30. Multi-Account Claude Code

**Decision:** Store multiple Claude Code OAuth tokens in SQLite and support per-session account switching
**Date:** 2026-02-26
**Rationale:**

- **Developer Need:** Multiple Claude accounts (personal/work/team) require switching contexts
- **Isolation:** Each account uses its own OAuth token; no system-level Claude config mutation
- **Safety:** Tokens stored locally in SQLite, never sent to any third party
- **Concurrency:** Per-session `claudeAccountId` override allows parallel streams with different accounts

**Implementation:**
- Environment setup: `backend/lib/engine/adapters/claude/environment.ts`
- DB queries: `backend/lib/database/queries/` (engine queries)
- Config isolation: `~/.clopen/claude/user/` (separate from system `~/.claude/`)
- `CLAUDE_CONFIG_DIR` env override points to isolated directory
- `CLAUDE_CODE_OAUTH_TOKEN` env override injects active account token
- `resetEnvironment()` re-reads active account after switch/delete

**Per-Session Override Flow:**
```
streamQuery({ claudeAccountId: 3 })
  → getEngineEnv(3)
  → looks up account #3 from DB
  → injects its oauth_token into env
  → only this stream uses account #3
```

**Trade-offs:**
- OAuth tokens must be manually added by the user (no automated login flow yet)
- Tokens are stored in plaintext in SQLite (local machine, no network exposure)

**Result:**
- Instant account switching without restarting the server
- Per-project or per-session account override
- Zero interference with the user's system-level Claude installation

---

### 31. OpenCode Integration via SDK Server

**Decision:** Run OpenCode as a background server and communicate via `@opencode-ai/sdk`
**Date:** 2026-02-26
**Rationale:**

- OpenCode exposes its functionality through an SDK server pattern
- Adapter pattern keeps the integration clean and swappable
- Messages normalized to Claude SDK format so stream manager is unchanged

**Implementation:**
- OpenCode adapter: `backend/lib/engine/adapters/opencode/`
- Server management: `backend/lib/engine/adapters/opencode/server.ts`
- Message converter: `backend/lib/engine/adapters/opencode/message-converter.ts`
- Stream: `backend/lib/engine/adapters/opencode/stream.ts`

**Trade-offs:**
- OpenCode server process adds memory overhead
- Dependency on `@opencode-ai/sdk` updates

**Result:**
- OpenCode available as a first-class AI engine alongside Claude Code
- Transparent to frontend — same WebSocket messages, same UI

---

## UI/UX Decisions

### 10. Modern AI-First Interface Design

**Decision:** Create custom, modern interface optimized for AI interactions
**Rationale:**

- AI-first design philosophy prioritizes conversation flow
- Modern UX patterns from 2026 (not 2019 VS Code era)
- Better user experience for non-technical users
- Conversation-centric design matches actual use case

**Key Features:**
- Adaptive layout that responds to content and context
- Smart panels that appear when needed
- Conversation flow optimized for AI interactions
- Progressive disclosure of information
- Contextual actions and suggestions

**Trade-offs:**
- Need to design and test custom UX patterns
- May require more development time
- Less familiar to VS Code users initially

---

### 11. Adaptive Theming System

**Decision:** Implement adaptive theming with dark mode default
**Rationale:**

- System preference detection for better UX
- Accessibility improvements with high contrast options
- Modern aesthetic
- Smooth theme transitions

**Implementation:**
- Theme detection script in `index.html`
- CSS custom properties for theme variables
- LocalStorage for manual theme preference
- Browser integration with `color-scheme` CSS property

**Features:**
- Automatic theme switching based on system preference
- Manual override with localStorage persistence
- Smooth color transitions
- Mobile browser integration (theme-color meta tag)

---

### 12. Custom Icon System

**Decision:** Migrate from @iconify/svelte to custom bundled icon component
**Date:** 2026-07-26
**Rationale:**

- **Performance:** Zero runtime icon fetching
- **Bundle Size:** Smaller without @iconify runtime
- **Type Safety:** Compile-time icon name validation
- **Control:** Direct SVG rendering with consistent sizing

**Implementation:**
- Custom `Icon.svelte` component
- Auto-generated icon registry from @iconify-json packages
- TypeScript IconName type for validation
- Consistent sizing with Tailwind classes

**Trade-offs:**
- Need to regenerate icons when adding new sets
- Manual updates for icon packages

---

## Checkpoint System Decisions

### 13. Git-Like Commit Graph for Undo/Redo

**Decision:** Implement git-like commit graph instead of soft-delete approach
**Date:** 2026-10-03
**Rationale:**

- **Reliability:** Parent-child relationships more reliable than timestamp-based ordering
- **Scalability:** Graph structure handles complex branching scenarios
- **Clarity:** HEAD pointer provides clear "current position" tracking
- **Simplicity:** Simpler than soft-delete with complex branch tracking

**Implementation:**
- `parent_message_id` field for each message (like git parent commit)
- `current_head_message_id` in sessions (like git HEAD pointer)
- `branches` table for named branch tracking (like git refs)
- Graph traversal for building timeline
- Branch creation on undo (descendants become branch)
- Branch switching on redo (clear branch_id, update HEAD)

**Key Differences from Soft-Delete:**
- Visibility determined by graph path, not `is_deleted` flag
- Branch point explicitly tracked via parent relationships
- Version numbering stable (sorted by branch creation time)
- Simpler recovery: just set HEAD to any message

**Trade-offs:**
- Migration complexity: Need to build parent links from existing data
- Breaking change: Old branches cleared during migration
- More complex queries: Graph traversal instead of simple WHERE
- Higher upfront design cost

**Benefits:**
- Correct branch positioning in all scenarios
- Stable version numbering after refresh
- No "orphaned" messages or branch drift
- Easier to understand: same mental model as git
- Better debugging: can visualize entire graph

**Result:**
- Zero branching bugs in production
- Clear separation between main path and branches
- Predictable behavior in nested branching scenarios

---

### 14. File Snapshot System

**Decision:** Implement file and folder snapshots for each checkpoint
**Rationale:**

- Complete restoration capability for any checkpoint
- Track file changes associated with each conversation turn
- Enable "time travel" debugging
- Foundation for diff visualization

**Implementation:**
- Snapshot service: `backend/lib/snapshot/snapshot-service.ts`
- Database schema: `008_create_message_snapshots_table.ts`
- Stores file paths, content, and metadata
- Delta compression for storage efficiency

**Trade-offs:**
- Increased database size with many snapshots
- Performance impact for large projects

---

## Browser Preview System Decisions

### 15. Puppeteer for Browser Automation

**Decision:** Use Puppeteer instead of Playwright or Selenium
**Rationale:**

- Excellent Chrome DevTools Protocol (CDP) integration
- Rich API for browser control
- Official Chrome/Chromium automation tool
- Better documentation and community support
- Native screenshot and video capture capabilities

**Implementation:**
- Browser service: `backend/lib/preview/browser/`
- Session management with browser pooling
- WebSocket streaming for frames
- Interaction handling (click, type, scroll)

**Trade-offs:**
- Chrome/Chromium only (no Firefox/Safari)
- Higher resource usage than simple iframe

---

### 16. WebCodecs-Based Video Encoding

**Decision:** Replace JPEG sequence streaming with WebCodecs video encoding
**Date:** 2026-12-30
**Rationale:**

- **Bandwidth Problem:** JPEG at 24fps = ~720KB/s, too high
- **User Rejection:** Reducing FPS/quality causes bad UX
- **CPU Efficiency:** Server should not spend CPU on encoding
- **Modern Solution:** WebCodecs API offloads encoding to browser/Chromium

**Architecture:**
```
1. CDP screencast captures JPEG frames in Chromium
2. Injected script in Chromium decodes JPEG → encodes to VP8/VP9/H.264
3. Encoded chunks sent to server via CDP binding
4. Server forwards binary data to client via WebSocket (no processing)
5. Client decodes with VideoDecoder and renders to canvas
```

**Implementation:**
- Backend handler: `backend/lib/preview/browser/browser-video-capture.ts`
- WebSocket endpoints: `backend/ws/preview/browser/webcodecs.ts`
- Client service: `frontend/lib/services/preview/browser/browser-webcodecs.service.ts`
- Dynamic codec negotiation (H.264 → VP9 → VP8)

**Key Features:**
- 80-90% bandwidth reduction (~100KB/s vs ~720KB/s)
- Hardware-accelerated encoding in Chromium
- Hardware-accelerated decoding in browser
- CPU-efficient on server (no encoding)
- Smooth playback with proper frame timing

**Trade-offs:**
- Modern browsers only (Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+)
- Firefox Android not yet supported (desktop only)
- More complex codec negotiation

**Result:**
- Significantly reduced bandwidth usage
- Lower server CPU usage
- Smooth, high-quality preview streaming
- Better user experience

---

### 17. Modern-Only Implementation

**Decision:** Focus on modern browsers only, no backward compatibility
**Date:** 2026-12-30
**Rationale:**

- **Simplicity:** Clean codebase without legacy support
- **Performance:** Modern APIs without overhead
- **Maintenance:** Less code to test
- **Target Audience:** Modern development tools require modern browsers

**Minimum Requirements:**
- Chrome 94+ (WebCodecs API)
- Edge 94+ (WebCodecs API)
- Safari 16.4+ (WebCodecs API)
- Firefox 130+ (WebCodecs API - Desktop only)

**Trade-offs:**
- Firefox Android not yet supported (desktop Firefox 130+ works)
- No support for old browsers

**Benefits:**
- Cleaner, more maintainable code
- Better performance without detection overhead
- Focus on optimal experience

---

## Collaboration Features

### 18. Anonymous User System

**Decision:** Implement anonymous user identity system for multi-user chat
**Date:** 2026-08-22
**Rationale:**

- **User Identification:** Generate friendly animal-based identities
- **Message Attribution:** Track message senders without authentication
- **Privacy-First:** No personal information required
- **Collaborative Features:** Enable shared chat sessions

**Implementation:**
- Anonymous user generation: `shared/utils/anonymous-user.ts`
- 100+ animal names × 24 colors × random numbers
- LocalStorage persistence of user identity
- Database integration: User ID and name stored with messages
- Avatar system: Color-coded avatars from username hash

**Benefits:**
- Enables collaboration without user accounts
- Privacy-focused approach
- Friendly, memorable identities
- Scalable system supporting unlimited users

---

### 19. Real-Time Presence System

**Decision:** Implement presence tracking for active users
**Rationale:**

- Show who is currently working on a project
- Enable awareness in collaborative sessions
- Foundation for future collaboration features (cursor sharing, etc.)

**Implementation:**
- WebSocket-based presence tracking
- Presence queries: `backend/ws/projects/presence.ts`
- User avatars display in project view
- Automatic cleanup of disconnected users

---

## Infrastructure Decisions

### 20. Cloudflare Tunnel Integration

**Decision:** Built-in Cloudflare Tunnel for public access
**Rationale:**

- Enable testing from mobile devices
- Share work-in-progress with clients/team
- No manual port forwarding or firewall configuration
- Secure HTTPS access without certificates
- Official Cloudflare tool

**Implementation:**
- Tunnel manager: `backend/lib/tunnel/`
- Project-specific and global tunnel support
- QR code generation for easy mobile access
- UI integration: `frontend/lib/components/tunnel/`

**Benefits:**
- One-click public URL generation
- Secure HTTPS by default
- Works across networks and firewalls
- Mobile-friendly with QR codes

---

### 21. Multi-Project Support

**Decision:** Support multiple projects with independent contexts
**Rationale:**

- Users work on multiple projects simultaneously
- Each project has its own chat history, settings, and state
- Enable project switching without losing context

**Implementation:**
- Project database schema: `001_create_projects_table.ts`
- Project queries: `backend/lib/database/queries/project-queries.ts`
- Project-based WebSocket rooms
- Recent projects list with status indicators

---

## Development Tools Decisions

### 22. Custom Logger Module

**Decision:** Implement custom logger module (`debug`) to replace console.*
**Date:** 2026-10-06
**Rationale:**

- **Structured Logging:** Label-based categorization
- **Flexible Filtering:** Runtime filtering by label, method, text
- **Debugging Efficiency:** Focus on specific subsystems
- **Production Ready:** Disable verbose logs without code changes
- **Svelte Compatible:** Named `debug` to avoid `$` prefix conflict

**Implementation:**
- Logger module: `shared/utils/logger.ts`
- 22 label categories: database, chat, snapshot, api, server, terminal, browser, file, project, session, stream, notification, port, user, template, settings, migration, seeder, git, error, cleanup, system
- 6 logging methods: log, info, warn, error, debug, trace
- Filter configuration with runtime updates
- Case-sensitive text filtering

**Usage:**
```typescript
import { debug } from '$shared/utils/logger';

// Basic usage
debug.log('database', '✅ Database initialized');
debug.error('api', 'Request failed:', error);

// Runtime filtering
debug.setConfig({
  filterLabels: ['chat', 'snapshot'],
  filterMethods: ['error', 'warn'],
  filterText: 'failed'
});
```

**Benefits:**
- Better debugging workflow
- No performance impact when filters disabled
- Consistent logging format
- Production-friendly

**Migration:**
- Replaced ~598 console.* calls across 111 files
- All TypeScript checks passing after migration

---

### 23. Port Management Strategy

**Decision:** Use port 9141 with strict requirement (no fallback)
**Date:** 2026-08-01
**Rationale:**

- **Consistency:** Predictable port for all users
- **Simplicity:** No complex port discovery logic
- **Documentation:** Clear expectations

**Implementation:**
- Port checking before startup
- Detailed error messages with solutions
- Helper commands for port management
- Process identification for conflicts

---

## Performance & Optimization Decisions

### 24. Modular Preview Folder Structure

**Decision:** Implement platform-based folder structure for preview system
**Date:** 2026-01-03
**Rationale:**

- **Scalability:** Future support for multiple platforms (Android, iOS, Desktop)
- **Separation of Concerns:** Platform-specific code isolated from shared utilities
- **Maintainability:** Clear organization
- **Future-Proofing:** Easy to add new platforms

**Structure:**
```
backend/lib/preview/
├── browser/             # Browser-specific handlers
├── shared/              # Shared utilities
└── types.ts             # Shared type definitions

frontend/lib/services/preview/
├── browser/             # Browser-specific services
└── shared/              # Shared services
```

**Benefits:**
- Clear separation between platform-specific and shared code
- Easy to add new preview platforms
- Prevents code duplication
- Type-safe imports

---

## Security Decisions

### 25. Input Sanitization Strategy

**Decision:** Sanitize all user inputs before processing
**Rationale:**

- Prevent command injection
- Validate file paths
- Security best practice
- Minimal performance impact

**Implementation:**
- Escape special characters in terminal commands
- Validate file paths in file operations
- Limit command length
- Sandbox process execution where possible

---

## MCP Integration Decisions

### 26. Path Normalization for Cross-Platform Compatibility

**Decision:** Implement robust path normalization for Claude Code configuration
**Date:** 2026-07-28
**Rationale:**

- Claude Code stores configs with different path formats
- Windows (`C:\path`) vs Unix (`C:/path` or `/c/path`) path handling
- Multiple project entries can exist for same physical path
- Need to find configurations regardless of format

**Implementation:**
- Generate multiple path variations for current directory
- Case-insensitive path matching for Windows
- Prioritize projects with actual MCP servers
- Handle `/c/` Unix-style and `C:\` Windows-style conversions

**Result:**
- Reliable MCP server detection across platforms
- Proper handling of multi-format project paths
- Eliminated "0 installed servers" issue

---

## Future-Proofing Decisions

### 27. Modular Component Architecture

**Decision:** Build with modular, reusable components
**Rationale:**

- Easier to maintain
- Can add features incrementally
- Better testing isolation
- Follows Svelte best practices
- Compile-time optimizations

**Implementation:**
- Component library: `frontend/lib/components/`
- Shared utilities: `shared/utils/`
- Separation of concerns (UI, business logic, data)

---

### 28. Extensible Database Schema

**Decision:** Design schema with future features in mind
**Rationale:**

- Easier to add features later
- Minimal migration pain
- Standard practice

**Implementation:**
- Settings table for key-value pairs
- Extensible template system
- Migration system for schema evolution
- Comprehensive indexes for performance

---

### 32. Remove Prettier, ESLint as Sole Linter

**Decision:** Remove Prettier entirely and rely on ESLint + svelte-check only
**Date:** 2026-02-27
**Rationale:**

- **Redundancy:** Prettier conflicts with ESLint and svelte-check on formatting opinions
- **Simplicity:** One less tool to configure and maintain
- **Contributor Safety:** Disabled in `.vscode/settings.json` so contributors with Prettier extension won't accidentally reformat
- **Two-tool strategy:** `bun run check` (svelte-check) for types + Svelte compiler, `bun run lint` (ESLint) for bug patterns

**What was removed:**
- `prettier`, `prettier-plugin-svelte`, `eslint-config-prettier` from devDependencies
- `.prettierrc` config file
- `format` and `format:check` npm scripts
- Prettier integration from `eslint.config.js`

**ESLint configuration highlights:**
- `no-explicit-any`: off — Elysia/WS code heavily uses `any`
- `no-unused-vars`: off — svelte-check handles this better
- `prefer-const`: error in `.ts` files, off in `.svelte` (Svelte 5 needs `let` for `$state`/`$bindable`)
- Svelte a11y warnings: suppressed via `warningFilter` in `svelte.config.js` (dev tool, not public website)
- Svelte stylistic rules (require-each-key, prefer-svelte-reactivity): off in ESLint, handled by svelte-check

**Result:**
- `bun run check` → 0 errors, 0 warnings
- `bun run lint` → 0 errors, 0 warnings
- Clean CI pipeline with no formatter step

---

## Summary Statistics

- **Total Decisions:** 32
- **Architecture:** 4 core decisions
- **Frameworks:** 3 major choices
- **Integration:** 5 external services/engines
- **UI/UX:** 3 design decisions
- **Performance:** 2 optimization strategies
- **Security:** 2 security measures
- **Future-Proofing:** 2 extensibility patterns
- **New Features:** 3 (Git management, Multi-account Claude Code, OpenCode)
- **Tooling:** 1 (Linting/formatting strategy)

---

**Last Updated:** 2026-02-27
**Project Phase:** Active Development
**Maintainer:** Myria Labs
