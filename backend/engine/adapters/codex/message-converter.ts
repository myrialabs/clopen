/**
 * Codex SDK → Unified Type Converters
 *
 * Translates Codex `ThreadEvent` objects into `EngineOutput` (unified types)
 * so the stream-manager and frontend can stay engine-agnostic.
 *
 * Streaming model — live emission:
 *
 *   thread.started                              → SystemInitEvent (capture thread_id)
 *   turn.started                                → StreamLifecycleEvent { event:'start' }
 *   item.started   (reasoning)                  → StreamLifecycleEvent { reasoning:true, event:'start' }
 *   item.updated   (reasoning, cumulative text) → TextDeltaEvent { reasoning:true, delta:<diff> }
 *   item.updated   (agent_message, cumulative)  → TextDeltaEvent { reasoning:false, delta:<diff> }
 *   item.updated   (todo_list)                  → AssistantMessage(tool_use:TodoWrite) live
 *   item.completed (todo_list)                  → AssistantMessage(tool_use:TodoWrite) + UserMessage(tool_result)
 *   item.completed (reasoning)                  → StreamLifecycleEvent { reasoning:true, event:'stop' }
 *   item.completed (agent_message)              → AssistantMessage live
 *   item.completed (command_execution)          → AssistantMessage(tool_use:Bash) + UserMessage(tool_result)
 *   item.completed (file_change)                → split N file changes → N AssistantMessage(tool_use)
 *   item.completed (mcp_tool_call)              → AssistantMessage(tool_use) + UserMessage(tool_result)
 *   item.completed (web_search, non-empty query) → AssistantMessage(tool_use:WebSearch) + UserMessage(tool_result)
 *                                                  (empty query → dropped — model emitted a malformed/interrupted call)
 *   item.completed (error)                      → UserMessage live (non-fatal notification)
 *   turn.completed (with usage)                 → StreamLifecycleEvent { event:'stop' } (usage captured)
 *   turn.failed                                 → throw via handleStreamError
 *   error                                       → throw via handleStreamError
 *
 * Usage attribution — Codex emits `usage` ONLY ONCE per turn, AFTER all items
 * have streamed. Live emission means tool_use messages get persisted before
 * usage is known. To ensure tool_use rows still carry usage in the DB (and
 * therefore after refresh), the stream-manager performs a post-stream
 * backfill on the `result` event for Codex streams: every saved assistant
 * with `usage: null` is updated with the turn's aggregate. See
 * stream-manager.ts → `backfillUsageForStream`.
 *
 * Usage source — `event.usage` from the SDK is the SUM of `input_tokens`
 * across every internal API call within the turn (cost-accounting view).
 * For the context-window % indicator we want PER-CALL input, so we read
 * `last_token_usage` from the rollout JSONL after `turn.completed`. See
 * ./usage-rollout.ts.
 */

import type { MessageEngine } from '$shared/types/unified';
import type {
	EngineOutput,
	UserMessage,
	AssistantMessage as UnifiedAssistantMessage,
	AssistantContentBlock,
	UserContentBlock,
	ToolUseBlock,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	SystemInitEvent,
	TokenUsage,
	BashInput,
	WriteInput,
	EditInput,
	WebSearchInput,
	TodoWriteInput,
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';
import type {
	ThreadEvent,
	ThreadItem,
	Usage,
	CommandExecutionItem,
	FileChangeItem,
	McpToolCallItem,
	AgentMessageItem,
	ReasoningItem,
	WebSearchItem,
	TodoListItem,
	ErrorItem,
	ThreadStartedEvent,
	TurnCompletedEvent,
} from '@openai/codex-sdk';
import { resolveOpenCodeToolName } from '../../../mcp/config';
import { readLastTokenUsageFromRollout } from './usage-rollout';
import { readApplyPatchesFromRollout, findMatchingPatch } from './patch-rollout';

// ============================================================================
// Engine Identity
// ============================================================================

export function buildEngine(modelId: string): MessageEngine {
	return {
		type: 'codex',
		provider: 'openai',
		model: { id: modelId, name: '' },
		account: { id: 0, name: '' },
	};
}

// ============================================================================
// Per-stream State
// ============================================================================

export interface CodexStreamState {
	sessionId: string;
	modelId: string;
	/** Cumulative reasoning text already streamed per item id (for diffing). */
	reasoningSent: Map<string, string>;
	/** Cumulative agent_message text already streamed per item id (for diffing). */
	agentMessageSent: Map<string, string>;
	/** Whether the reasoning lifecycle is currently open. */
	reasoningStreamActive: boolean;
	/** Last seen usage (carried across turns into ResultEvent). */
	lastUsage: Usage | null;
	/** Stop reason for the current/last turn. */
	stopReason: 'end_turn' | 'tool_use' | 'interrupted' | null;
	/** Total turn count for ResultEvent. */
	numTurns: number;
}

export function createCodexState(sessionId: string, modelId: string): CodexStreamState {
	return {
		sessionId,
		modelId,
		reasoningSent: new Map(),
		agentMessageSent: new Map(),
		reasoningStreamActive: false,
		lastUsage: null,
		stopReason: null,
		numTurns: 0,
	};
}

// ============================================================================
// Tool name + input mapping
// ============================================================================

function canonicalizeMcpToolName(server: string, tool: string): string {
	// Codex prefixes MCP tools with the server name (`<server>__<tool>` or
	// `<server>.<tool>` depending on the CLI version). We prefer the
	// shared mcp config resolver so the resulting `mcp__server__tool` name
	// matches what other engines emit.
	const candidate = `${server}__${tool}`;
	const resolved = resolveOpenCodeToolName(candidate) ?? resolveOpenCodeToolName(`clopen-mcp_${tool}`);
	if (resolved) return toCanonicalToolName(resolved);
	return toCanonicalToolName(`mcp__${server}__${tool}`);
}

// ============================================================================
// Event entry points
// ============================================================================

export function convertThreadStarted(event: ThreadStartedEvent, state: CodexStreamState): EngineOutput[] {
	state.sessionId = event.thread_id;
	const init: SystemInitEvent = {
		type: 'system_init',
		sessionId: event.thread_id,
		model: state.modelId,
		engine: 'codex',
		tools: [],
		mcpServers: [{ name: 'clopen-mcp', status: 'connected' }],
	};
	return [init];
}

export function convertTurnStarted(state: CodexStreamState): EngineOutput[] {
	state.numTurns += 1;
	state.stopReason = null;
	const start: StreamLifecycleEvent = {
		type: 'stream_event',
		event: 'start',
		sessionId: state.sessionId,
		reasoning: false,
	};
	return [start];
}

export function convertItemStarted(event: { item: ThreadItem }, state: CodexStreamState): EngineOutput[] {
	const item = event.item;
	if (item.type === 'reasoning') {
		if (!state.reasoningStreamActive) {
			state.reasoningStreamActive = true;
			state.reasoningSent.set(item.id, '');
			const lifecycle: StreamLifecycleEvent = {
				type: 'stream_event',
				event: 'start',
				sessionId: state.sessionId,
				reasoning: true,
			};
			return [lifecycle];
		}
	}

	return [];
}

export function convertItemUpdated(event: { item: ThreadItem }, state: CodexStreamState): EngineOutput[] {
	const item = event.item;

	if (item.type === 'reasoning') {
		// Codex sends cumulative reasoning text on each update — diff against
		// what we've already streamed so the UI sees only the new suffix.
		return diffReasoning(item, state);
	}

	if (item.type === 'agent_message') {
		// Stream agent text the same way: cumulative diff → TextDeltaEvent.
		return diffAgentMessage(item, state);
	}

	if (item.type === 'todo_list') {
		// Live emit so todos appear progressively. Each emit is a separate
		// AssistantMessage(tool_use:TodoWrite); the frontend grouper
		// dedups by tool-use id at render time.
		return [buildTodoAssistantMessage(item, state)];
	}

	return [];
}

export function convertItemCompleted(event: { item: ThreadItem }, state: CodexStreamState): EngineOutput[] {
	const item = event.item;
	switch (item.type) {
		case 'reasoning':
			return finalizeReasoning(item, state);
		case 'agent_message':
			return [buildAgentAssistantMessage(item, state)];
		case 'command_execution':
			return buildCommandExecutionPair(item, state);
		case 'file_change':
			return buildFileChangePair(item, state);
		case 'mcp_tool_call':
			return handleMcpToolCallCompleted(item, state);
		case 'web_search':
			return buildWebSearchPair(item, state);
		case 'todo_list':
			return buildTodoListCompletedPair(item, state);
		case 'error':
			return [buildErrorUserMessage(item, state)];
	}
	return [];
}

export function convertTurnCompleted(event: TurnCompletedEvent, state: CodexStreamState): EngineOutput[] {
	// `event.usage` from the SDK is the SUM of `input_tokens` across every
	// internal API call within this turn (so a 5-tool-call turn reports ~5×
	// the actual prompt size). Prefer `last_token_usage` from the CLI's
	// rollout JSONL — that's the real per-call context-window load. Fall
	// back to `event.usage` if the rollout file isn't readable.
	// TODO(codex-sdk): once the SDK exposes per-call usage natively, replace
	// `readLastTokenUsageFromRollout` with the SDK field and delete
	// ./usage-rollout.ts (see migration steps in that file's header).
	const rolloutUsage = readLastTokenUsageFromRollout(state.sessionId);
	state.lastUsage = rolloutUsage ?? event.usage ?? state.lastUsage;
	if (state.stopReason === null) {
		state.stopReason = 'end_turn';
	}

	// Note: the per-turn `usage` aggregate is NOT attached to individual
	// assistant messages here — they were already saved live during the turn
	// (with usage:null). The stream-manager backfills usage after the result
	// event by looking up each saved row's DB id. See README §9.4.

	const stopLifecycle: StreamLifecycleEvent = {
		type: 'stream_event',
		event: 'stop',
		sessionId: state.sessionId,
		reasoning: false,
	};

	return [stopLifecycle];
}

export function buildResultEvent(state: CodexStreamState, aborted: boolean): SuccessResultEvent {
	const usage = mapUsage(state.lastUsage);
	return {
		type: 'result',
		subtype: 'success',
		sessionId: state.sessionId,
		numTurns: state.numTurns,
		totalCostUsd: 0,
		usage,
		stopReason: aborted ? 'interrupted' : (state.stopReason ?? 'end_turn'),
	};
}

// ============================================================================
// Reasoning helpers
// ============================================================================

function diffReasoning(item: ReasoningItem, state: CodexStreamState): EngineOutput[] {
	const previous = state.reasoningSent.get(item.id) ?? '';
	const next = item.text ?? '';
	if (next.length <= previous.length) return [];
	const delta = next.slice(previous.length);
	state.reasoningSent.set(item.id, next);

	const out: EngineOutput[] = [];
	if (!state.reasoningStreamActive) {
		state.reasoningStreamActive = true;
		out.push({
			type: 'stream_event',
			event: 'start',
			sessionId: state.sessionId,
			reasoning: true,
		} as StreamLifecycleEvent);
	}
	out.push({
		type: 'stream_event',
		event: 'delta',
		sessionId: state.sessionId,
		text: delta,
		reasoning: true,
	} as TextDeltaEvent);
	return out;
}

function finalizeReasoning(item: ReasoningItem, state: CodexStreamState): EngineOutput[] {
	const out: EngineOutput[] = [];
	const previous = state.reasoningSent.get(item.id) ?? '';
	const fullText = item.text ?? '';
	if (fullText.length > previous.length) {
		out.push({
			type: 'stream_event',
			event: 'delta',
			sessionId: state.sessionId,
			text: fullText.slice(previous.length),
			reasoning: true,
		} as TextDeltaEvent);
	}
	state.reasoningSent.delete(item.id);

	if (state.reasoningStreamActive) {
		state.reasoningStreamActive = false;
		out.push({
			type: 'stream_event',
			event: 'stop',
			sessionId: state.sessionId,
			reasoning: true,
		} as StreamLifecycleEvent);
	}

	if (fullText.trim()) {
		out.push({
			type: 'reasoning',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId: state.sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine: buildEngine(state.modelId),
			text: fullText,
		});
	}

	return out;
}

// ============================================================================
// Agent-message text helpers
// ============================================================================

function diffAgentMessage(item: AgentMessageItem, state: CodexStreamState): EngineOutput[] {
	const previous = state.agentMessageSent.get(item.id) ?? '';
	const next = item.text ?? '';
	if (next.length <= previous.length) return [];
	const delta = next.slice(previous.length);
	state.agentMessageSent.set(item.id, next);

	return [{
		type: 'stream_event',
		event: 'delta',
		sessionId: state.sessionId,
		text: delta,
		reasoning: false,
	} as TextDeltaEvent];
}

// ============================================================================
// Assistant message builders
// ============================================================================

function buildAgentAssistantMessage(item: AgentMessageItem, state: CodexStreamState): UnifiedAssistantMessage {
	state.agentMessageSent.delete(item.id);
	return {
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId: item.id || crypto.randomUUID(),
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		content: [{ type: 'text', text: item.text ?? '' }],
		stopReason: 'end_turn',
		usage: null,
	};
}

function buildToolUseBlock(name: string, input: Record<string, unknown>, id: string): ToolUseBlock {
	return {
		type: 'tool_use',
		id,
		name: toCanonicalToolName(name),
		input,
		result: null,
		subActivities: [],
		skillPrompt: null,
		interrupted: false,
	} as ToolUseBlock;
}

function createAssistantToolUseMessage(
	state: CodexStreamState,
	block: ToolUseBlock,
	baseId: string,
	idx?: number,
): UnifiedAssistantMessage {
	const messageId = idx === undefined ? baseId : `${baseId}:${idx}`;
	return {
		type: 'assistant',
		createdAt: new Date().toISOString(),
		messageId,
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		content: [block as AssistantContentBlock],
		stopReason: 'tool_use',
		usage: null,
	};
}

function buildToolResultUserMessage(
	toolUseId: string,
	content: string,
	isError: boolean,
	state: CodexStreamState,
): UserMessage {
	const block: UserContentBlock = {
		type: 'tool_result',
		toolUseId,
		content,
		isError,
	};
	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId: state.sessionId,
		// IMPORTANT: parent.toolUseId stays null (README §9.5 sharp edge).
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		sender: { id: '', name: '' },
		content: [block],
		synthetic: true,
	};
}

function buildCommandExecutionPair(item: CommandExecutionItem, state: CodexStreamState): EngineOutput[] {
	const input: BashInput = { command: item.command };
	const block = buildToolUseBlock('Bash', input as unknown as Record<string, unknown>, item.id);
	const assistant = createAssistantToolUseMessage(state, block, item.id);
	const result = buildToolResultUserMessage(
		item.id,
		item.aggregated_output ?? '',
		item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0),
		state,
	);
	state.stopReason = 'tool_use';
	return [assistant, result];
}

function buildFileChangePair(item: FileChangeItem, state: CodexStreamState): EngineOutput[] {
	// Codex bundles N file changes per item. Per README §9.3 we split into N
	// separate AssistantMessages so each shows up as its own tool block.
	const out: EngineOutput[] = [];
	const baseId = item.id;
	const isFailed = item.status === 'failed';

	// SDK doesn't carry diff content on FileUpdateChange — pull it from the
	// rollout JSONL's apply_patch envelope so Edit blocks render real before/
	// after text. Falls back to empty strings if the rollout isn't readable.
	const updatePaths = item.changes.filter(c => c.kind === 'update').map(c => c.path);
	const matchedPatch = updatePaths.length > 0
		? findMatchingPatch(readApplyPatchesFromRollout(state.sessionId), updatePaths)
		: null;

	item.changes.forEach((change, idx) => {
		const toolId = `${baseId}:${idx}`;
		let toolName: string;
		let input: Record<string, unknown>;

		if (change.kind === 'add') {
			toolName = 'Write';
			input = { filePath: change.path, content: '' } satisfies WriteInput as unknown as Record<string, unknown>;
		} else if (change.kind === 'update') {
			toolName = 'Edit';
			const diff = matchedPatch?.get(change.path);
			input = {
				filePath: change.path,
				oldString: diff?.oldString ?? '',
				newString: diff?.newString ?? '',
			} satisfies EditInput as unknown as Record<string, unknown>;
		} else {
			// delete → no canonical UI; map to Bash `rm <path>` so the user
			// at least sees what was removed (plan §4.2).
			toolName = 'Bash';
			input = {
				command: `rm ${JSON.stringify(change.path)}`,
				description: `Codex deleted ${change.path}`,
			} satisfies BashInput as unknown as Record<string, unknown>;
		}

		const block = buildToolUseBlock(toolName, input, toolId);
		const assistant = createAssistantToolUseMessage(state, block, baseId, idx);
		const result = buildToolResultUserMessage(
			toolId,
			isFailed ? `File change failed: ${change.path}` : `Applied ${change.kind} to ${change.path}`,
			isFailed,
			state,
		);
		out.push(assistant, result);
	});
	state.stopReason = 'tool_use';
	return out;
}

function handleMcpToolCallCompleted(item: McpToolCallItem, state: CodexStreamState): EngineOutput[] {
	const isError = item.status === 'failed' || !!item.error;
	const resultText = extractMcpResultText(item);

	const canonical = canonicalizeMcpToolName(item.server, item.tool);
	const args = (item.arguments ?? {}) as Record<string, unknown>;
	const block = buildToolUseBlock(canonical, args, item.id);
	const assistant = createAssistantToolUseMessage(state, block, item.id);
	const result = buildToolResultUserMessage(item.id, resultText, isError, state);
	state.stopReason = 'tool_use';
	return [assistant, result];
}

function extractMcpResultText(item: McpToolCallItem): string {
	if (item.error?.message) return `Error: ${item.error.message}`;
	if (!item.result) return '';
	const blocks = item.result.content;
	if (!Array.isArray(blocks)) return '';
	const parts: string[] = [];
	for (const b of blocks) {
		if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
			parts.push((b as { text: string }).text);
		}
	}
	return parts.join('\n');
}

function buildWebSearchPair(item: WebSearchItem, state: CodexStreamState): EngineOutput[] {
	// The Codex SDK's WebSearchItem only carries the query — search results
	// are fed to the model directly and never surfaced to the adapter. If the
	// query is empty (model emitted a malformed call, or the turn was
	// interrupted before the call finalized), drop the entire pair so the UI
	// doesn't render a tool block with `query: ""` and `result: null`.
	const query = (item.query ?? '').trim();
	if (!query) return [];

	const input: WebSearchInput = { query };
	const block = buildToolUseBlock('WebSearch', input as unknown as Record<string, unknown>, item.id);
	const assistant = createAssistantToolUseMessage(state, block, item.id);
	// Synthetic tool_result so the frontend grouper attaches a non-null
	// result at render time (README §9.5). Without it `tool_use.result`
	// stays null forever.
	const result = buildToolResultUserMessage(
		item.id,
		`Searched the web for: ${query}`,
		false,
		state,
	);
	state.stopReason = 'tool_use';
	return [assistant, result];
}

function buildTodoAssistantMessage(item: TodoListItem, state: CodexStreamState): UnifiedAssistantMessage {
	const todos: TodoWriteInput['todos'] = item.items.map(t => ({
		content: t.text,
		status: t.completed ? 'completed' : 'pending',
		activeForm: t.text,
	}));
	const input: TodoWriteInput = { todos };
	const block = buildToolUseBlock('TodoWrite', input as unknown as Record<string, unknown>, item.id);
	return createAssistantToolUseMessage(state, block, item.id);
}

function buildTodoListCompletedPair(item: TodoListItem, state: CodexStreamState): EngineOutput[] {
	// item.updated emits multiple progressive snapshots (no tool_result), and
	// the grouper's toolUseMap.set() overwrites prior entries so the LAST
	// assistant for this tool_use.id wins. Pair the final completion with a
	// synthetic tool_result so that final entry has a non-null result after
	// refresh — without this the TodoWrite block stays "in progress" forever.
	const assistant = buildTodoAssistantMessage(item, state);
	const completedCount = item.items.filter(t => t.completed).length;
	const result = buildToolResultUserMessage(
		item.id,
		`Todos updated (${completedCount}/${item.items.length} completed)`,
		false,
		state,
	);
	return [assistant, result];
}

function buildErrorUserMessage(item: ErrorItem, state: CodexStreamState): UserMessage {
	// Item-level (non-fatal) errors surface as a synthetic user message so
	// the UI shows them inline rather than terminating the stream.
	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId: state.sessionId,
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		sender: { id: '', name: '' },
		content: [{ type: 'text', text: `Codex error: ${item.message}` }],
		synthetic: true,
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map Codex `Usage` → unified `TokenUsage`.
 *
 * Codex follows the OpenAI convention where `input_tokens` is the TOTAL
 * prompt size including any cached prefix, and `cached_input_tokens` is the
 * portion served from cache. The unified shape (Anthropic-aligned) treats
 * `inputTokens` as the FRESH prompt only — cached tokens go on
 * `cacheReadInputTokens`. Subtract here, otherwise the frontend's context
 * window indicator (which sums input + cacheCreate + cacheRead) would
 * double-count the cached prefix and appear to fill up far too quickly.
 */
function mapUsage(raw: Usage | null): TokenUsage {
	if (!raw) {
		return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	}
	const totalInput = raw.input_tokens ?? 0;
	const cached = raw.cached_input_tokens ?? 0;
	return {
		inputTokens: Math.max(0, totalInput - cached),
		outputTokens: (raw.output_tokens ?? 0) + (raw.reasoning_output_tokens ?? 0),
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: cached,
	};
}

// Re-export so the stream can import the union-narrowing helper
export type { ThreadEvent };
