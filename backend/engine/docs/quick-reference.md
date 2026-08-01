[← Engine adapter guide](../README.md)

## 11. Quick reference table

| Need                                        | File                                                      |
|---------------------------------------------|-----------------------------------------------------------|
| Lazy + concurrency-safe init                | `claude/environment.ts::setupEnvironmentOnce`, `opencode/server.ts::ensureClient` |
| Per-account credential override (env-var SDK) | `claude/environment.ts::getEngineEnv(accountId)`        |
| Per-account credential override (constructor SDK) | `copilot/stream.ts::initialize(accountId)` + dispose+reinit in `streamQuery` |
| Subprocess spawn + health + recovery        | `opencode/server.ts`                                      |
| Stateful per-stream converter               | `claude/message-converter.ts::createSdkMessageConverter`  |
| Split one SDK message → N `EngineOutput`    | `opencode/message-converter.ts::convertAssistantMessages`, `copilot/message-converter.ts::convertAssistantMessage` |
| Buffer until usage event arrives            | `copilot/message-converter.ts::flushPending` + `captureUsage` |
| Accumulate per-chunk delta stream → 1 msg   | `cursor/message-converter.ts` (`appendText`/`appendReasoning`/`flushAll` — deltas, not snapshots; see §10.20-A) |
| Unwrap a wrapper tool (MCP + custom tools)  | `cursor/message-converter.ts::canonicalCursorTool`/`cursorToolInput` (`mcp` wrapper → `mcp__server__tool` / AskUserQuestion; §10.20-C) |
| Interactive tool args from `execute`, not stream | `cursor/ask-question-tool.ts` (`emit`) + `cursor/message-converter.ts::emitAskUserQuestion` (push queue; §10.20-D) |
| Sub-agent streamed live via delta taskUpdate | `cursor/stream.ts` (`onDelta` `tool-call-delta.taskUpdate`) + `cursor/message-converter.ts::emitSubagentActivity`/`replaySubagent` (§10.20-E) |
| Freeze mutable tool args before persist     | `cursor/message-converter.ts::cloneArgs` (`structuredClone`; §10.20-H) |
| Usage backfill (once-per-turn engines)      | `backend/chat/stream-manager.ts::backfillUsageForStream` (Codex + Cursor; §10.20-I) |
| Context window unknown → "?" not 100%       | `frontend/utils/context-manager.ts` (`unknown`) + `frontend/components/chat/widgets/ContextIndicator.svelte` (§10.20-J) |
| Reasoning stream lifecycle                  | `opencode/stream.ts::flushReasoning`, `copilot/message-converter.ts::convertReasoningDelta` |
| Cancel-before-RPC ordering                  | `opencode/stream.ts::cancel`, `claude/stream.ts::cancel`, `copilot/stream.ts::cancel`  |
| Fork session (native vs. on-disk vs. in-memory) | `claude/stream.ts` (`forkSession: true`), `opencode/stream.ts` (`client.session.fork`), `copilot/stream.ts` (`client.rpc.sessions.fork`), `codex/session-fork.ts` + `qwen/session-fork.ts` (copy disk state), `pi/session-fork.ts` (`SessionManager.forkFrom`), `cline/stream.ts` (**session-less** — fresh id per turn + in-memory copy-on-branch; see §10.10) |
| Sub-agent (`Task`/`Agent`) routing          | `claude/message-converter.ts` (`parent_tool_use_id`), `opencode/message-converter.ts::convertSubtaskToolUseOnly`, `copilot/message-converter.ts::resolveParentToolUseId` + `agentParentMap`; **synthesized** `Agent` tool for bare-loop SDKs in `cline/agent-tool.ts` + `pi/agent-tool.ts` (see §10.15) |
| AskUserQuestion event + HTTP fallback       | `opencode/stream.ts::resolveUserAnswer`, `claude/stream.ts::canUseTool` |
| MCP servers exposed over HTTP (single source) | `backend/mcp/internal/remote-server.ts`, `backend/mcp/internal/config.ts::getOpenCodeMcpConfig` (and future `getXxxMcpConfig`) |
| Materialize an artifact per engine (matrix)  | `backend/artifacts/matrix.ts::resolveArtifact`, generic writer `backend/artifacts/sync.ts`, scanner `backend/artifacts/detect.ts` (see §8.2) |
| Per-stream artifact sync (Commands/Subagents/Instructions) | `backend/engine/artifact-sync.ts::syncEngineArtifacts` + `buildArtifactsPromptContext` — called from each `stream.ts` after `syncSkills` (see §8.3) |
| Profile scoping (narrow active artifacts)   | `backend/profiles/service.ts::resolveActiveProfileId` + `artifactFilter` (see §8.4) |
| Permission enforcement (runtime hook)        | `backend/permissions/service.ts::resolvePermissionsFromDb` + `isToolAllowed` (see §8.4) |
| Auth-blob swap into shared CLI dotfile      | Pattern only (no implementation yet); see §3.3 callout + §10.13 |
| Restart-Server pattern (long-lived engines) | `backend/ws/engine/opencode/providers.ts::engine:opencode-server-restart`, `frontend/components/chat/input/components/EngineModelPicker.svelte::restartOCServer`, `engines/panels/OpenCodePanel.svelte::handleRestartServer`/`forceRestartServer` |
| `generateStructured` (no tools, JSON)       | `claude/stream.ts::generateStructured` (native `outputFormat`), `codex/stream.ts::generateStructured` (native `outputSchema`); `opencode` / `copilot` / `qwen` / `pi` / `cline` / `cursor` are prompt-engineered via `backend/engine/structured-helpers.ts` (`buildJsonPrompt` + `extractJson`). See §10.16 for the strict-schema + part-fallback gotchas. |
| Resolve provider/account for a one-shot call | `backend/engine/resolve-model.ts::resolveGenerationTarget` — catalog is truth, caller's `providerSlug` is a hint (§10.16 point 3) |
| Tolerant JSON extraction (fences, trailing prose, raw newlines) | `backend/engine/structured-helpers.ts::extractJson` + `structured-helpers.test.ts` |
| Keep engine/provider/model from drifting apart | `frontend/utils/model-override.ts::modelFieldsOf` (spread it when persisting a generator override) |
| Reasoning-effort levels a model offers      | `EngineModel.capabilities.reasoningControl` built in `<engine>/models.ts` via `toReasoningOptions` (`shared/constants/engines.ts`); §2.4a |
| Apply the chosen reasoning level to the SDK | `claude/stream.ts` (`thinking` + `effort`), `codex/stream.ts` (`modelReasoningEffort`), `copilot/stream.ts` (`reasoningEffort`), `pi/stream.ts` (`thinkingLevel` + `clampThinkingLevel`), `cursor/stream.ts::buildCursorModelSelection` (`params[]`); §10.22 |
| Per-session reasoning persistence + collab sync | `chat_sessions.reasoning_effort` (migration `065`), `sessionQueries.updateReasoning`, `chat:reasoning-sync` in `backend/ws/chat/stream.ts` |
| Error normalisation                         | `claude/error-handler.ts`, `copilot/error-handler.ts`, `opencode/error-handler.ts`, `qwen/error-handler.ts`, `codex/error-handler.ts` |
| DB provider/account access                  | `backend/database/queries/engine-queries.ts`              |
| Host-tool + engine-SDK install recipes      | `backend/engine/install-recipes.ts`                       |
| On-demand engine-SDK loader (managed dir)   | `backend/engine/sdk-loader.ts` (`getStackEnginesDir`, `loadEngineSdk`) |
| Streaming install logs                      | `backend/engine/install-runner.ts`                        |
| Fresh-install default engine (auto OpenCode)| `backend/engine/bootstrap-default-engine.ts::ensureDefaultEngineInstalled`, called from `backend/bootstrap.ts::bootstrapAfterDbInit` (startup **and** Clear All Data); §7.8 |
| Engine + host-tool brand icons (SSOT)       | `shared/constants/tool-icons.ts::TOOL_ICONS` (referenced by `ENGINES` and the Stack cards) |
| Frontend account/provider stores            | `frontend/stores/features/{claude-accounts,copilot-accounts,opencode-providers}.svelte.ts` |
| Frontend chat-model state                   | `frontend/stores/ui/chat-model.svelte.ts`                 |
| Settings UI (Engines)                       | `frontend/components/settings/engines/AIEnginesSettings.svelte` (shell + grid) + `engines/panels/*Panel.svelte` (one per engine) |
| Settings UI (Stack)                         | `frontend/components/settings/stack/{StackSettings,ToolInstallCard}.svelte` |
| Chat picker (engine + model + account + reasoning) | `frontend/components/chat/input/components/EngineModelPicker.svelte` |
| Settings → Models (catalog + per-model reasoning defaults) | `frontend/components/settings/model/EngineModelPicker.svelte` (mounted by `AssistantSettings` / `GitSettings` / `ArtifactsSettings`); `setReasoningDefault` in `frontend/stores/features/settings.svelte.ts` |
| Chat send → backend                         | `frontend/services/chat/chat.service.ts` (`ws.emit('chat:stream', …)`), `backend/ws/chat/stream.ts` |
| Stream-manager (`EngineOutput` routing)     | `backend/chat/stream-manager.ts`                          |

When in doubt: **mirror** the existing adapters and let `EngineOutput`
remain the only contract that crosses the adapter boundary.
