# SDK Message Refactoring Plan

Migrasi total dari SDK-coupled types ke `shared/types/unified/`.

---

## Rules

- Tidak ada legacy atau backward compatibility — semua file, folder, types, variable, function boleh di-restructure total
- Tidak boleh menggunakan `any`, `unknown`, atau lazy typing seperti `type X = any`
- Tidak perlu menjelaskan perbandingan dengan sistem lama — fokus ke implementasi baru
- Semua types harus spesifik dan disesuaikan untuk kebutuhan sistem ini
- Icon/visual concern dikelola di frontend, bukan di types
- Setiap phase harus melewati `bun run check && bun run lint`

---

## SDK Versions

| Package | Before | After | Action |
|---------|--------|-------|--------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.63 | 0.2.101 | ✅ Updated. v2 API masih @alpha, tetap v1 query() |
| `@anthropic-ai/sdk` | 0.78.0 | 0.88.0 | ✅ Updated. Hapus setelah Phase 3 |
| `@opencode-ai/sdk` | 1.2.15 | 1.4.3 | ✅ Updated |

---

## Type Flow

```
Engine SDK → adapter → EngineOutput → stream-manager → UnifiedMessage → DB → Frontend
```

Type system terpusat di `shared/types/unified/`:

| File | Isi |
|------|-----|
| `common.ts` | TokenUsage, StopReason, EngineType |
| `tool.ts` | Tool input types, ToolInputMap, ToolUseBlock (dengan enrichment fields), ToolResult, SubAgentActivity |
| `message.ts` | MessageBase, content blocks, UserMessage, AssistantMessage, ReasoningMessage, CompactBoundaryMessage, UnifiedMessage |
| `display.ts` | ToolGroup, BackgroundBashData |
| `stream.ts` | StreamEvent, ResultEvent, SystemInitEvent, RateLimitEvent, EngineOutput, transport types |
| `index.ts` | Barrel exports |

---

## Phase 1: Backend Engine & Adapters

Scope: engine interface + semua adapters + stream manager.

### Adapter File Pattern

Kedua adapter mengikuti pola file yang sama agar engine baru mudah ditambahkan:

```
adapters/<engine>/
  index.ts              # re-exports
  stream.ts             # AIEngine implementation (class)
  message-converter.ts  # SDK → EngineOutput converters
  ...                   # engine-specific files (environment, server, config, etc.)
```

### Files

```
backend/engine/types.ts
  - Import semua types dari shared/types/unified
  - EngineQueryOptions.prompt → UserMessage
  - AIEngine.streamQuery() → AsyncGenerator<EngineOutput>
  - Hapus import dari shared/types/messaging

backend/engine/adapters/claude/stream.ts
  - Import converters dari ./message-converter
  - Tetap v1 query() (v2 belum support cwd, mcpServers, dll)
  - Import resolveOsPath dari $shared/utils/path

backend/engine/adapters/claude/message-converter.ts (BARU)
  - Converter terpisah menggunakan proper SDK types
  - SDKAssistantMessage, SDKUserMessage, SDKPartialAssistantMessage, dll
  - BetaContentBlock, BetaUsage dari @anthropic-ai/sdk
  - convertSdkMessage() generator: SDKMessage → EngineOutput
  - toSdkUserMessage(): UserMessage → SDKUserMessage

backend/engine/adapters/claude/index.ts
  - Re-exports (tidak berubah)

backend/engine/adapters/opencode/message-converter.ts
  - Convert langsung: OpenCode events → EngineOutput
  - Hapus semua Claude SDK type imports
  - Tool input normalisasi camelCase

backend/engine/adapters/opencode/stream.ts
  - Yield EngineOutput
  - extractPromptParts() menerima UserMessage

backend/engine/adapters/opencode/index.ts
  - Re-exports (tidak berubah)

backend/chat/stream-manager.ts
  - Import dari shared/types/unified
  - Route berdasarkan type discriminant (switch output.type)
  - saveMessage() menerima UnifiedMessage
  - cancelStream() membuat partial messages dalam unified format

backend/chat/helpers.ts
  - Import UnifiedMessage, StreamRequest dari unified

backend/database/queries/message-queries.ts
  - create() menerima SDKMessage | UnifiedMessage (transitional)

shared/utils/path.ts
  - Tambah resolveOsPath() (dari claude/path-utils.ts yang dihapus)
```

### SDK v2 API Status

v2 (`unstable_v2_createSession`) masih @alpha di SDK 0.2.101.
SDKSessionOptions hanya support: model, executable, env, allowedTools, canUseTool, hooks, permissionMode.

**Missing critical options:**
- `cwd` — Clopen multi-project, server cwd ≠ project path
- `mcpServers` — custom MCP server configuration
- `systemPrompt`, `settingSources`, `forkSession`
- `maxTurns`, `abortController`, `includePartialMessages`
- `outputFormat` — dibutuhkan generateStructured()

Migrasi ke v2 menunggu SDKSessionOptions mendapat options ini.

### Conversion Table

| SDK Event | → EngineOutput |
|-----------|---------------|
| SDKAssistantMessage | AssistantMessage |
| SDKUserMessage (tool_result) | UserMessage |
| SDKPartialAssistantMessage | TextDeltaEvent / StreamLifecycleEvent |
| SDKCompactBoundaryMessage | CompactBoundaryMessage |
| SDKResultMessage | ResultEvent |
| thinking/reasoning blocks | ReasoningMessage |

### Checkpoint Phase 1

```
[x] backend/engine/types.ts — selesai
[x] backend/engine/adapters/claude/stream.ts — selesai (tetap v1, import dari message-converter)
[x] backend/engine/adapters/claude/message-converter.ts — BARU, proper SDK types
[x] backend/engine/adapters/claude/index.ts — selesai (tidak berubah)
[x] backend/engine/adapters/opencode/message-converter.ts — selesai (camelCase, unified return)
[x] backend/engine/adapters/opencode/stream.ts — selesai
[x] backend/engine/adapters/opencode/index.ts — selesai (tidak berubah)
[x] backend/chat/stream-manager.ts — selesai (switch output.type routing)
[x] backend/chat/helpers.ts — selesai
[x] backend/database/queries/message-queries.ts — transitional (SDKMessage | UnifiedMessage)
[x] shared/utils/path.ts — tambah resolveOsPath()
[x] backend/engine/adapters/claude/path-utils.ts — DIHAPUS (pindah ke shared)

bun run check && bun run lint — PASS [x]

Notes:
- SDK diupdate: claude-agent-sdk 0.2.63→0.2.101, sdk 0.78.0→0.88.0, opencode 1.2.15→1.4.3
- v2 API (unstable_v2_createSession) masih @alpha, SDKSessionOptions tidak punya cwd/mcpServers/
  systemPrompt — blocker untuk Clopen multi-project. Tetap v1 query() sampai v2 stabil.
- Claude message-converter menggunakan proper SDK types (SDKAssistantMessage, BetaContentBlock,
  BetaUsage, dll) bukan Record<string, unknown>.
- Adapter file structure diselaraskan: kedua adapter punya index.ts + stream.ts + message-converter.ts.
- DB layer transisi: messageQueries.create() menerima SDKMessage | UnifiedMessage.
  Phase 2 akan full-migrate ke UnifiedMessage.
- SDK 0.88.0 mengubah export path (@anthropic-ai/claude-agent-sdk/sdk → root export)
  dan memperluas BetaContentBlock union → fix implicit any di frontend.
- Async Iteration (AsyncGenerator<EngineOutput>) dipertahankan:
  backpressure natural, single-consumer pattern, lifecycle clean.
  EventEmitter tetap untuk broadcast manager→WebSocket (1:N).
```

---

## Phase 2: Data Layer

Scope: database queries, schema, message formatter, snapshot system, dan MCP.

### Files

```
shared/types/database/schema.ts
  - Hapus SDKMessageFormatter (diganti UnifiedMessage langsung)
  - DatabaseMessage.sdk_message menyimpan serialized UnifiedMessage
  - Hapus import dari shared/types/messaging

shared/utils/message-formatter.ts
  - Sederhanakan menjadi JSON.parse → UnifiedMessage
  - Atau hapus jika tidak diperlukan

backend/database/queries/message-queries.ts
  - Return UnifiedMessage[]
  - JSON.parse(row.sdk_message) → UnifiedMessage
  - Runtime migration untuk data lama:
    function loadMessage(row): UnifiedMessage {
      const raw = JSON.parse(row.sdk_message);
      if (raw.id && raw.sessionId) return raw;
      return convertLegacyMessage(raw, row);
    }

backend/database/queries/session-queries.ts
backend/database/queries/snapshot-queries.ts
  - Update type references

backend/snapshot/helpers.ts
  - Gunakan UnifiedMessage

backend/snapshot/snapshot-service.ts
  - Update type references

backend/ws/snapshot/timeline.ts
  - Update type references

backend/mcp/config.ts
  - Tetap import createSdkMcpServer, tool dari claude-agent-sdk (runtime API, tidak berubah)

backend/mcp/types.ts
  - Tetap import McpSdkServerConfigWithInstance (runtime config type, tidak berubah)
```

> MCP server creation menggunakan runtime API dari Claude SDK (`tool()`, `createSdkMcpServer()`), bukan message types. Perlu verifikasi tidak ada message type imports yang perlu diganti.

### Checkpoint Phase 2

```
[x] shared/types/database/schema.ts — SDKMessageFormatter + EngineSDKMessage import dihapus total
[x] shared/utils/message-formatter.ts — hanya loadMessage() + old-format converter internal
[x] backend/database/queries/message-queries.ts — semua fungsi pakai loadMessage()
[x] backend/database/queries/session-queries.ts — verified (tidak ada messaging imports)
[x] backend/database/queries/snapshot-queries.ts — verified (tidak ada messaging imports)
[x] backend/snapshot/helpers.ts — semua fungsi terima UnifiedMessage, pakai loadMessage()
[x] backend/snapshot/snapshot-service.ts — verified (tidak ada messaging imports)
[x] backend/ws/snapshot/timeline.ts — pakai loadMessage(), tidak ada raw JSON.parse
[x] backend/ws/messages/crud.ts — pakai loadMessage() + extractMessageText dari helpers
[x] backend/mcp/config.ts — verified (runtime API saja)
[x] backend/mcp/types.ts — verified (runtime config type saja)

bun run check — 12 errors (semua di frontend/, expected untuk Phase 3)
bun run lint — PASS [x]

Notes:
- TIDAK ada dual-format handling di consumer code.
  loadMessage() adalah satu-satunya entry point untuk konversi old format → UnifiedMessage.
- Semua consumer (helpers.ts, timeline.ts, crud.ts, message-queries.ts) hanya bekerja
  dengan UnifiedMessage — tidak ada lagi Record<string, unknown> atau raw JSON.parse
  kecuali di dalam loadMessage() sendiri.
- markInterruptedMessages(): load via loadMessage(), write back sebagai UnifiedMessage
  (effectively migrate-on-write untuk old format data).
- helpers.ts: isInternalToolMessage() dan extractMessageText() hanya terima UnifiedMessage.
  isSessionContinuation() helper baru menggantikan inline type checks.
- crud.ts: sessions:preview pakai loadMessage() + extractMessageText(), tidak ada
  extractTextContent() manual lagi.
```

---

## Phase 3: Frontend + Cleanup

Scope: semua frontend code (services, stores, utilities, components) dan penghapusan legacy.

### Files

```
frontend/services/chat/chat.service.ts
  - Handle MessageTransportData format baru
  - Import dari shared/types/unified

frontend/stores/core/sessions.svelte.ts
  - Message arrays menggunakan UnifiedMessage[]
  - addMessage() langsung menerima UnifiedMessage

frontend/stores/core/projects.svelte.ts
  - Update type imports

frontend/utils/chat/message-processor.ts
  - Gunakan UnifiedMessage dan ToolUseBlock
  - isToolUseBlock(): block.type === 'tool_use'
  - isToolResultBlock(): block.type === 'tool_result'
  - extractToolUses(): filter AssistantMessage.content
  - Hapus ToolInput union (gunakan ToolUseBlock, discriminate pada name)

frontend/utils/chat/message-grouper.ts
  - Gunakan UnifiedMessage
  - ToolGroup dari unified types
  - Enrichment: populate block.result, block.subActivities langsung di ToolUseBlock

frontend/utils/chat/tool-handler.ts
  - Gunakan UnifiedMessage
  - SubAgentActivity dari unified types
  - Tool enrichment tulis langsung ke ToolUseBlock fields

frontend/utils/chat/date-separator.ts
frontend/utils/context-manager.ts
frontend/utils/tree-visualizer.ts
  - Update type imports

frontend/components/chat/message/ChatMessage.svelte
frontend/components/chat/message/MessageBubble.svelte
frontend/components/chat/message/MessageHeader.svelte
frontend/components/chat/modal/DebugModal.svelte
  - Gunakan UnifiedMessage
  - Akses langsung: message.id, message.createdAt, message.model, dll

frontend/components/chat/formatters/MessageFormatter.svelte
  - Gunakan UnifiedMessage

frontend/components/chat/formatters/Tools.svelte
  - Gunakan ToolUseBlock
  - Discriminate pada block.name untuk narrowing input type

frontend/components/chat/ChatInterface.svelte
frontend/components/chat/widgets/FloatingTodoList.svelte
frontend/components/history/HistoryView.svelte
frontend/components/history/HistoryModal.svelte
frontend/components/workspace/DesktopNavigator.svelte
frontend/components/workspace/MobileNavigator.svelte
  - Update type imports
```

### Tool Components

Setiap tool component menerima props dari ToolUseBlock yang sudah di-narrow:

```svelte
<script lang="ts">
  import type { BashInput, ToolResult } from '$shared/types/unified';
  let { input, result }: { input: BashInput; result: ToolResult | null } = $props();
</script>
```

Tool components yang perlu diupdate:
- BashTool, BashOutputTool, EditTool, GlobTool, GrepTool, ReadTool
- WebFetchTool, WebSearchTool, WriteTool, TodoWriteTool
- TaskTool, TaskStopTool, AskUserQuestionTool
- EnterPlanModeTool, ExitPlanModeTool, SkillTool, AgentTool
- ListMcpResourcesTool, ReadMcpResourceTool, NotebookEditTool, CustomMcpTool

### Cleanup

```
1. Hapus shared/types/messaging/ (seluruh directory)
2. Hapus atau sederhanakan shared/utils/message-formatter.ts (jika belum di phase 2)
3. Hapus SDKMessageFormatter dari shared/types/database/schema.ts (jika belum di phase 2)
4. Hapus @anthropic-ai/sdk dari dependencies
5. bun run check && bun run lint
```

### Checkpoint Phase 3

```
[ ] frontend/services/chat/chat.service.ts — selesai
[ ] frontend/stores/core/sessions.svelte.ts — selesai
[ ] frontend/stores/core/projects.svelte.ts — selesai
[ ] frontend/utils/chat/message-processor.ts — selesai
[ ] frontend/utils/chat/message-grouper.ts — selesai
[ ] frontend/utils/chat/tool-handler.ts — selesai
[ ] frontend/utils/chat/date-separator.ts — selesai
[ ] frontend/utils/context-manager.ts — selesai
[ ] frontend/utils/tree-visualizer.ts — selesai
[ ] frontend/components — semua message/formatter/tool components selesai
[ ] frontend/components — semua other components selesai

Cleanup:
[ ] shared/types/messaging/ — dihapus
[ ] shared/utils/message-formatter.ts — dihapus / disederhanakan
[ ] @anthropic-ai/sdk — dihapus dari dependencies

bun run check && bun run lint — PASS [ ]

Notes:
(isi catatan/blocker/keputusan yang dibuat selama phase ini)
```

---

## Execution Summary

| # | Phase | Scope | Risk | Files |
|---|-------|-------|------|-------|
| 1 | Backend Engine & Adapters | engine + adapters + stream manager | High | ~8 files |
| 2 | Data Layer | DB + snapshot + MCP | Medium | ~10 files |
| 3 | Frontend + Cleanup | services + stores + utils + components + cleanup | Medium-Low | ~50 files |

**Total: ~68 files**

---

## SDK Dependencies Setelah Migrasi

| Package | Status | Alasan |
|---------|--------|--------|
| `@anthropic-ai/claude-agent-sdk` | Tetap | Runtime: query(), MCP tools, permission system |
| `@anthropic-ai/sdk` | Hapus (Phase 3) | Beta types dipakai di message-converter, hapus setelah frontend migrated |
| `@opencode-ai/sdk` | Tetap | Runtime: createOpencode, SSE stream |
