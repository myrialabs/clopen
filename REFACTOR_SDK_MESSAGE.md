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

| Package | Current | Action |
|---------|---------|--------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.63 (v1) | Update ke latest, migrate ke v2 API |
| `@anthropic-ai/sdk` | 0.78.0 | Hapus setelah migrasi (content block types sudah di unified) |
| `@opencode-ai/sdk` | 1.2.15 | Update ke latest |

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

## Phase 1: Backend Engine Interface

**File:** `backend/engine/types.ts`

```
- Import semua types dari `shared/types/unified`
- EngineQueryOptions.prompt → UserMessage
- AIEngine.streamQuery() → AsyncGenerator<EngineOutput>
- Hapus import dari shared/types/messaging
```

---

## Phase 2: Claude Code SDK v1 → v2

Migrasi dari `query()` ke session-based API.

### SDK v2 API

```ts
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession
} from '@anthropic-ai/claude-agent-sdk';

const session = unstable_v2_createSession({ ... });
const session = unstable_v2_resumeSession(sessionId, { ... });

for await (const event of session.stream(prompt)) {
  // process events
}
```

### Files

```
backend/engine/adapters/claude/stream.ts
  - Ganti query() dengan createSession/resumeSession
  - Convert SDK events → EngineOutput
  - Handle v2 session lifecycle (create, resume, close)

backend/engine/adapters/claude/index.ts
  - Manage SDKSession state untuk cancel/interrupt/resume
```

### Conversion Table

| SDK Event | → EngineOutput |
|-----------|---------------|
| SDKAssistantMessage | AssistantMessage |
| SDKUserMessage (tool_result) | UserMessage |
| SDKPartialAssistantMessage | TextDeltaEvent / StreamLifecycleEvent |
| SDKCompactBoundaryMessage | CompactBoundaryMessage |
| SDKResultMessage | ResultEvent |
| thinking/reasoning blocks | ReasoningMessage |

---

## Phase 3: OpenCode Adapter

### Files

```
backend/engine/adapters/opencode/message-converter.ts
  - Convert langsung: OpenCode events → EngineOutput
  - Hapus semua Claude SDK type imports

backend/engine/adapters/opencode/stream.ts
  - Yield EngineOutput

backend/engine/adapters/opencode/index.ts
  - Update imports
```

---

## Phase 4: Stream Manager

Central hub yang memproses EngineOutput dari adapters.

### Files

```
backend/chat/stream-manager.ts
  - Import dari shared/types/unified
  - Route berdasarkan type discriminant:
    - user/assistant/reasoning/compact_boundary → persist + emit via WebSocket
    - stream_event → forward ke frontend (PartialMessageData)
    - result → extract usage, log completion
    - system_init → emit notifications
    - rate_limit → emit notification
  - MessageTransportData hanya berisi processId + message + usage
  - StreamNotification tanpa icon (icon dikelola frontend)

backend/chat/helpers.ts
  - Update imports
```

---

## Phase 5: Database Layer

### Schema

```
shared/types/database/schema.ts
  - Hapus SDKMessageFormatter (diganti UnifiedMessage langsung)
  - DatabaseMessage.sdk_message menyimpan serialized UnifiedMessage
  - Hapus import dari shared/types/messaging
```

### Message Formatter

```
shared/utils/message-formatter.ts
  - Sederhanakan menjadi JSON.parse → UnifiedMessage
  - Atau hapus jika tidak diperlukan
```

### Database Queries

```
backend/database/queries/message-queries.ts
  - Return UnifiedMessage[]
  - JSON.parse(row.sdk_message) → UnifiedMessage

backend/database/queries/session-queries.ts
backend/database/queries/snapshot-queries.ts
  - Update type references
```

### DB Migration

Data lama di DB perlu di-convert saat dibaca. Gunakan runtime migration:

```ts
function loadMessage(row: DatabaseRow): UnifiedMessage {
  const raw = JSON.parse(row.sdk_message);
  if (raw.id && raw.sessionId) return raw;
  return convertLegacyMessage(raw, row);
}
```

Fungsi `convertLegacyMessage` mapping format lama ke UnifiedMessage. Setelah seluruh migrasi selesai dan data lama sudah tidak ada, fungsi ini bisa dihapus.

---

## Phase 6: Snapshot System

```
backend/snapshot/helpers.ts
  - Gunakan UnifiedMessage

backend/snapshot/snapshot-service.ts
  - Update type references

backend/ws/snapshot/timeline.ts
  - Update type references
```

---

## Phase 7: Frontend Services & Stores

### Chat Service

```
frontend/services/chat/chat.service.ts
  - Handle MessageTransportData format baru
  - Import dari shared/types/unified
```

### Stores

```
frontend/stores/core/sessions.svelte.ts
  - Message arrays menggunakan UnifiedMessage[]
  - addMessage() langsung menerima UnifiedMessage

frontend/stores/core/projects.svelte.ts
  - Update type imports
```

---

## Phase 8: Frontend Utilities

```
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
```

---

## Phase 9: Frontend Components

### Message Display

```
frontend/components/chat/message/ChatMessage.svelte
frontend/components/chat/message/MessageBubble.svelte
frontend/components/chat/message/MessageHeader.svelte
frontend/components/chat/modal/DebugModal.svelte
  - Gunakan UnifiedMessage
  - Akses langsung: message.id, message.createdAt, message.model, dll
```

### Formatters

```
frontend/components/chat/formatters/MessageFormatter.svelte
  - Gunakan UnifiedMessage

frontend/components/chat/formatters/Tools.svelte
  - Gunakan ToolUseBlock
  - Discriminate pada block.name untuk narrowing input type
```

### Tool Components

Setiap tool component menerima props dari ToolUseBlock yang sudah di-narrow:

```svelte
<script lang="ts">
  import type { BashInput, ToolResult } from '$shared/types/unified';
  let { input, result }: { input: BashInput; result: ToolResult | null } = $props();
</script>
```

Tool components:
- BashTool, BashOutputTool, EditTool, GlobTool, GrepTool, ReadTool
- WebFetchTool, WebSearchTool, WriteTool, TodoWriteTool
- TaskTool, TaskStopTool, AskUserQuestionTool
- EnterPlanModeTool, ExitPlanModeTool, SkillTool, AgentTool
- ListMcpResourcesTool, ReadMcpResourceTool, NotebookEditTool, CustomMcpTool

### Other Components

```
frontend/components/chat/ChatInterface.svelte
frontend/components/chat/widgets/FloatingTodoList.svelte
frontend/components/history/HistoryView.svelte
frontend/components/history/HistoryModal.svelte
frontend/components/workspace/DesktopNavigator.svelte
frontend/components/workspace/MobileNavigator.svelte
  - Update type imports
```

---

## Phase 10: MCP Integration

```
backend/mcp/config.ts
  - Tetap import createSdkMcpServer, tool dari claude-agent-sdk (runtime API)

backend/mcp/types.ts
  - Tetap import McpSdkServerConfigWithInstance (runtime config type)
```

MCP server creation menggunakan runtime API dari Claude SDK (`tool()`, `createSdkMcpServer()`), bukan message types. Tidak perlu migrasi.

---

## Phase 11: Cleanup

```
1. Hapus shared/types/messaging/ (seluruh directory)
2. Hapus atau sederhanakan shared/utils/message-formatter.ts
3. Hapus SDKMessageFormatter dari shared/types/database/schema.ts
4. Hapus @anthropic-ai/sdk dari dependencies
5. bun run check && bun run lint
```

---

## Execution Order

| # | Phase | Scope | Risk |
|---|-------|-------|------|
| 1 | Engine interface | 1 file | Low |
| 2 | Claude adapter v2 | 2 files | High |
| 3 | OpenCode adapter | 3 files | Medium |
| 4 | Stream manager | 2 files | High |
| 5 | Database layer | 4 files | Medium |
| 6 | Snapshot system | 3 files | Low |
| 7 | Frontend services/stores | 3 files | Medium |
| 8 | Frontend utilities | 6 files | Medium |
| 9 | Frontend components | ~30 files | Low |
| 10 | MCP integration | 2 files | Low |
| 11 | Cleanup | Delete old files | Low |

**Total: ~67 files**

---

## SDK Dependencies Setelah Migrasi

| Package | Status | Alasan |
|---------|--------|--------|
| `@anthropic-ai/claude-agent-sdk` | Tetap | Runtime: createSession, MCP tools, permission system |
| `@anthropic-ai/sdk` | Hapus | Content block types sudah di unified |
| `@opencode-ai/sdk` | Tetap | Runtime: createOpencode, SSE stream |
