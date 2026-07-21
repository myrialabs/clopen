/**
 * Cursor SDK → Unified Type Converter.
 *
 * `run.stream()` yields discrete `SDKMessage`s (Cursor's stream carries complete
 * messages; token-level deltas ride the optional `onDelta` callback, not used
 * here). We translate each into `EngineOutput`:
 *
 *   system     → SystemInitEvent (model + tool names)
 *   user       → dropped (echoes the prompt; stream-manager persists the real one)
 *   assistant  → AssistantMessage(s): one per text / tool_use block
 *   thinking   → ReasoningMessage
 *   tool_call  → tool_use AssistantMessage (running, if not already surfaced) +
 *                tool_result UserMessage (completed / error)
 *   usage      → captured for the final ResultEvent
 *
 * Cursor built-in tool names (`read`, `edit`, `shell`, …) are canonicalised to the
 * unified PascalCase names so the shared tool UI renders identically to the other
 * engines. MCP tools route through `resolveOpenCodeToolName()` to recover their
 * `mcp__<server>__<tool>` form.
 */

import type {
	MessageEngine,
	EngineOutput,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	ToolUseBlock,
	UserContentBlock,
	StreamLifecycleEvent,
	TextDeltaEvent,
	SuccessResultEvent,
	SystemInitEvent,
	TokenUsage,
	AskUserQuestion,
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';
import type { SDKMessage, RunResult, TokenUsage as CursorTokenUsage } from '@cursor/sdk';
import { resolveOpenCodeToolName } from '../../../mcp';

// ============================================================
// Tool name + input normalisation
// ============================================================

const CURSOR_TOOL_NAME_MAP: Record<string, string> = {
	read: 'Read',
	write: 'Write',
	edit: 'Edit',
	ls: 'List',
	glob: 'Glob',
	grep: 'Grep',
	shell: 'Bash',
	task: 'Agent',
	update_todos: 'TodoWrite',
	updatetodos: 'TodoWrite',
	// Cursor's `create_plan` records a markdown plan; the ExitPlanMode tool
	// component renders `input.plan`, so it's the right unified home.
	create_plan: 'ExitPlanMode',
	createplan: 'ExitPlanMode',
	web_search: 'WebSearch',
	fetch: 'WebFetch',
};

function mapCursorToolName(rawName: string): string {
	if (rawName.startsWith('mcp__')) return rawName;
	const resolved = resolveOpenCodeToolName(rawName);
	if (resolved) return resolved;
	const mapped = CURSOR_TOOL_NAME_MAP[rawName.toLowerCase()] ?? rawName;
	return toCanonicalToolName(mapped);
}

/**
 * Cursor routes BOTH real MCP servers AND our in-process `customTools` through a
 * single wrapper tool named `mcp`, with args `{ providerIdentifier, toolName, args }`:
 *   - real MCP  → `{ providerIdentifier: 'clopen-mcp', toolName: 'open_new_tab', args: {…} }`
 *   - customTool→ `{ providerIdentifier: 'custom-user-tools', toolName: 'AskUserQuestion', args: {…} }`
 * Unwrap it so the UI renders the proper `mcp__<server>__<tool>` / `AskUserQuestion`
 * component instead of an `Unknown:mcp` block.
 */
function isMcpWrapper(name: string, args: Record<string, unknown>): args is { toolName: string; args?: unknown } {
	return name === 'mcp' && typeof args.toolName === 'string';
}

function canonicalCursorTool(name: string, args: Record<string, unknown>): string {
	if (isMcpWrapper(name, args)) {
		const bare = args.toolName;
		return resolveOpenCodeToolName(bare) ?? toCanonicalToolName(bare);
	}
	return mapCursorToolName(name);
}

function cursorToolInput(name: string, args: Record<string, unknown>, result?: unknown): Record<string, unknown> {
	if (isMcpWrapper(name, args)) {
		const inner = (args.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>;
		// Real MCP tools pass their args through unchanged; custom/unknown tools
		// (e.g. AskUserQuestion) go through the per-tool normaliser.
		return resolveOpenCodeToolName(args.toolName) ? inner : normaliseToolInput(toCanonicalToolName(args.toolName), inner, result);
	}
	return normaliseToolInput(mapCursorToolName(name), args, result);
}

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Map a Cursor todo status (`inProgress`/`cancelled`/…) to the unified UI status. */
function mapTodoStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
	switch (status) {
		case 'inProgress':
		case 'in_progress':
			return 'in_progress';
		case 'completed':
		case 'cancelled':
			return 'completed';
		default:
			return 'pending';
	}
}

/**
 * Freeze a snapshot of tool args. Cursor mutates some arg objects in place across
 * a tool's streaming lifecycle (notably the `update_todos` list, whose statuses
 * flip to "completed" as work progresses) — persisting a live reference captures
 * that later state, so a just-created todo renders as already done. A structural
 * clone at emit time pins the args to the moment the tool_use is surfaced.
 */
function cloneArgs(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') return {};
	try {
		return structuredClone(raw) as Record<string, unknown>;
	} catch {
		try {
			return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
		} catch {
			return raw as Record<string, unknown>;
		}
	}
}

/**
 * Extract a unified-diff string from a Cursor tool result (`edit` success carries
 * `value.diffString`).
 */
function extractDiffString(result: unknown): string | null {
	const value = (result as { value?: { diffString?: unknown } })?.value;
	return typeof value?.diffString === 'string' ? value.diffString : null;
}

/**
 * Parse a unified diff into before/after text. Context lines (leading space)
 * appear in BOTH sides; `-` lines are the old side, `+` lines the new side.
 * File headers (`---`/`+++`) and hunk headers (`@@`) are skipped.
 */
function parseUnifiedDiff(diff: string): { oldString: string; newString: string } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of diff.split('\n')) {
		if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
		if (line.startsWith('-')) oldLines.push(line.slice(1));
		else if (line.startsWith('+')) newLines.push(line.slice(1));
		else if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
	}
	return { oldString: oldLines.join('\n'), newString: newLines.join('\n') };
}

/**
 * Light per-tool input normalisation into the shared canonical shape. `result`
 * (present at tool completion) is used for tools whose ARGS don't carry the
 * user-visible payload — Cursor's `edit` args hold only `path`; the before/after
 * lives in the result's `diffString`.
 */
function normaliseToolInput(canonical: string, raw: Record<string, unknown>, result?: unknown): Record<string, unknown> {
	switch (canonical) {
		case 'Read':
			return { filePath: String(raw.path ?? raw.file_path ?? raw.filePath ?? '') };
		case 'Write':
			return {
				filePath: String(raw.path ?? raw.file_path ?? raw.filePath ?? ''),
				content: String(raw.fileText ?? raw.contents ?? raw.content ?? raw.text ?? ''),
			};
		case 'Edit': {
			const filePath = String(raw.path ?? raw.file_path ?? raw.filePath ?? '');
			// Cursor edit args carry only `path`; recover old/new from the result diff.
			const diff = extractDiffString(result);
			if (diff) return { filePath, ...parseUnifiedDiff(diff) };
			return {
				filePath,
				oldString: String(raw.old_string ?? raw.oldString ?? raw.old_str ?? ''),
				newString: String(raw.new_string ?? raw.newString ?? raw.new_str ?? ''),
			};
		}
		case 'Bash':
			return { command: String(raw.command ?? raw.cmd ?? '') };
		case 'Grep':
			return {
				pattern: String(raw.pattern ?? raw.query ?? raw.regex ?? ''),
				...(raw.path != null ? { path: String(raw.path) } : {}),
			};
		case 'Glob':
			return { pattern: String(raw.globPattern ?? raw.pattern ?? raw.glob ?? raw.query ?? '') };
		case 'Agent': {
			// Cursor's `task` args carry `subagentType` as an OBJECT
			// (`{ kind: 'custom', name: 'code-reviewer' }`); the unified AgentInput
			// wants a plain string.
			const st = raw.subagentType;
			let subagentType = 'general-purpose';
			if (typeof st === 'string') subagentType = st;
			else if (st && typeof st === 'object') {
				const o = st as { kind?: string; name?: string };
				subagentType = o.name || o.kind || 'general-purpose';
			}
			return {
				prompt: String(raw.prompt ?? ''),
				description: String(raw.description ?? ''),
				subagentType,
			};
		}
		case 'List':
			return {
				...(raw.path != null ? { path: String(raw.path) } : {}),
				...(Array.isArray(raw.ignore) ? { ignore: raw.ignore.map(String) } : {}),
			};
		case 'ExitPlanMode':
			return { plan: String(raw.plan ?? '') };
		case 'TodoWrite': {
			// Cursor todo statuses are `pending | inProgress | completed | cancelled`;
			// the unified/UI shape wants `pending | in_progress | completed`.
			const todos = (Array.isArray(raw.todos) ? raw.todos : []).map((t) => {
				const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
				const content = String(o.content ?? '');
				return {
					content,
					status: mapTodoStatus(o.status),
					activeForm: typeof o.activeForm === 'string' ? o.activeForm : content,
				};
			});
			return { todos };
		}
		case 'AskUserQuestion':
			return { questions: Array.isArray(raw.questions) ? raw.questions : [] };
		default: {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(raw)) out[snakeToCamel(k)] = v;
			return out;
		}
	}
}

// ============================================================
// Helper mappers
// ============================================================

function mapUsage(raw: CursorTokenUsage | null | undefined): TokenUsage {
	return {
		inputTokens: raw?.inputTokens ?? 0,
		outputTokens: raw?.outputTokens ?? 0,
		cacheCreationInputTokens: raw?.cacheWriteTokens ?? 0,
		cacheReadInputTokens: raw?.cacheReadTokens ?? 0,
	};
}

/** Read the text out of one Cursor/MCP content item (`{type:'text',text}`, Cursor's `{text:{text}}`, image → placeholder). */
function contentItemText(item: unknown): string {
	if (typeof item === 'string') return item;
	const it = item as { type?: string; text?: unknown; image?: unknown };
	if (it?.type === 'text' && typeof it.text === 'string') return it.text;
	if (it?.text && typeof it.text === 'object' && typeof (it.text as { text?: unknown }).text === 'string') return (it.text as { text: string }).text;
	if (typeof it?.text === 'string') return it.text;
	if (it?.image) return '[image]';
	return '';
}

/**
 * Extract plain text from a tool-call result. Cursor wraps results as
 * `{ status, value }`, where `value` is `{ content: [...] }` (text/image items,
 * incl. the nested `{text:{text}}` shape), `{ text }`, or `{ diffString }` (edit).
 * Falls back to MCP-standard `{content:[{type:'text',text}]}` and JSON.
 */
function extractResultText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	const r = result as { value?: unknown; success?: unknown; content?: unknown; text?: unknown };
	// Cursor wraps top-level tool results as `{status,value}` and sub-agent tool
	// results as `{success:{…}}`; unwrap either.
	const value = (r.value ?? r.success ?? r) as { content?: unknown; text?: unknown; diffString?: unknown };

	if (Array.isArray(value.content)) {
		const joined = value.content.map(contentItemText).filter(Boolean).join('\n').trim();
		if (joined) return joined;
	}
	if (typeof value.content === 'string') return value.content;
	if (typeof value.text === 'string') return value.text;
	if (typeof value.diffString === 'string') return value.diffString;
	if (typeof r.text === 'string') return r.text;
	if (Array.isArray(r.content)) {
		const joined = r.content.map(contentItemText).filter(Boolean).join('\n').trim();
		if (joined) return joined;
	}
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

// ============================================================
// Converter
// ============================================================

export interface CursorConverterOptions {
	engine: MessageEngine;
	sessionId: string;
}

export interface CursorMessageConverter {
	convert(message: SDKMessage): EngineOutput[];
	finalize(result: RunResult): EngineOutput[];
	/** Surface an AskUserQuestion tool_use with complete questions (from the custom tool's execute). */
	emitAskUserQuestion(toolCallId: string, questions: AskUserQuestion[]): EngineOutput[];
	/** Stream ONE sub-agent step live (from a `tool-call-delta.taskUpdate`) as a child of the Agent block. */
	emitSubagentActivity(agentToolId: string, taskUpdate: unknown): EngineOutput[];
}

export function createCursorMessageConverter(options: CursorConverterOptions): CursorMessageConverter {
	const { engine, sessionId } = options;
	/** Tool-call ids already surfaced as a tool_use block (avoid duplicates). */
	const emittedToolUse = new Set<string>();
	/** Agent (task) tool ids whose sub-agent steps were streamed live via onDelta. */
	const streamedSubagents = new Set<string>();
	let lastUsage: TokenUsage | null = null;
	let turns = 0;
	// ── Live-typing + accumulation state ──
	// Cursor's `run.stream()` yields each text/thinking CHUNK as its own
	// `assistant`/`thinking` SDKMessage (deltas, not snapshots). We stream each
	// chunk live as a transient `stream_event` AND accumulate it into a buffer,
	// flushing ONE consolidated `reasoning` / `assistant` message per block at a
	// boundary (block switch, tool call, or turn end). Persisting each chunk
	// separately was the bug behind dozens of fragmented one-word messages.
	let textOpen = false;
	let reasoningOpen = false;
	let textBuffer = '';
	let reasoningBuffer = '';

	/** Flush the accumulated reasoning buffer as ONE ReasoningMessage (+ close its live stream). */
	function flushReasoning(): EngineOutput[] {
		const out: EngineOutput[] = [];
		if (reasoningOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: true }); reasoningOpen = false; }
		const text = reasoningBuffer.trim();
		reasoningBuffer = '';
		if (text) {
			out.push({
				type: 'reasoning',
				createdAt: new Date().toISOString(),
				messageId: crypto.randomUUID(),
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: null },
				engine,
				text,
			} as ReasoningMessage);
		}
		return out;
	}

	/** Flush the accumulated text buffer as ONE AssistantMessage (+ close its live stream). */
	function flushText(): EngineOutput[] {
		const out: EngineOutput[] = [];
		if (textOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false }); textOpen = false; }
		const text = textBuffer;
		textBuffer = '';
		if (text.trim()) out.push(assistantMessage({ type: 'text', text }, false));
		return out;
	}

	/** Flush both buffers (reasoning first, then text). */
	function flushAll(): EngineOutput[] {
		return [...flushReasoning(), ...flushText()];
	}

	/** Append a live text chunk: flush any open reasoning, stream the delta, accumulate. */
	function appendText(chunk: string): EngineOutput[] {
		const out: EngineOutput[] = flushReasoning();
		if (!textOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent); textOpen = true; }
		out.push({ type: 'stream_event', event: 'delta', sessionId, text: chunk, reasoning: false } as TextDeltaEvent);
		textBuffer += chunk;
		return out;
	}

	/** Append a live reasoning chunk: flush any open text, stream the delta, accumulate. */
	function appendReasoning(chunk: string): EngineOutput[] {
		const out: EngineOutput[] = flushText();
		if (!reasoningOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent); reasoningOpen = true; }
		out.push({ type: 'stream_event', event: 'delta', sessionId, text: chunk, reasoning: true } as TextDeltaEvent);
		reasoningBuffer += chunk;
		return out;
	}

	function assistantMessage(block: ToolUseBlock | { type: 'text'; text: string }, isTool: boolean, parentToolUseId: string | null = null): AssistantMessage {
		return {
			type: 'assistant',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: parentToolUseId },
			engine,
			content: [block],
			stopReason: isTool ? 'tool_use' : 'end_turn',
			usage: null,
		} as AssistantMessage;
	}

	function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
		return {
			type: 'tool_use',
			id,
			name,
			input,
			result: null,
			subActivities: [],
			skillPrompt: null,
			interrupted: false,
		} as ToolUseBlock;
	}

	function toolResultMessage(toolUseId: string, content: string, isError: boolean, parentToolUseId: string | null = null): UserMessage {
		const block: UserContentBlock = { type: 'tool_result', toolUseId, content, isError };
		return {
			type: 'user',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: parentToolUseId },
			engine,
			sender: { id: '', name: '' },
			content: [block],
			synthetic: true,
		};
	}

	/**
	 * Cursor's `task` (Agent) tool runs the sub-agent internally and returns its
	 * FULL transcript in `result.value.conversationSteps[]` — the parent stream
	 * never sees the sub-agent's individual steps. We replay those steps as child
	 * messages tagged with `parent.toolUseId = <Agent block id>` so the frontend
	 * grouper folds them into the Agent block's `subActivities` (README §10.15).
	 * The sub-agent's final assistant text becomes the Agent tool's result.
	 */
	function replaySubagent(result: unknown, agentToolId: string): { children: EngineOutput[]; finalText: string } {
		const steps = (result as { value?: { conversationSteps?: unknown } })?.value?.conversationSteps;
		if (!Array.isArray(steps)) return { children: [], finalText: extractResultText(result) };
		const children: EngineOutput[] = [];
		let finalText = '';
		for (const step of steps as Array<Record<string, unknown>>) {
			const asst = step.assistantMessage as { text?: unknown } | undefined;
			if (asst && typeof asst.text === 'string' && asst.text.trim()) {
				finalText = asst.text; // last assistant text = the sub-agent's answer (Agent result)
				continue;
			}
			const tc = step.toolCall as Record<string, unknown> | undefined;
			if (tc) {
				const key = Object.keys(tc).find(k => k.endsWith('ToolCall'));
				const inner = (key ? tc[key] : undefined) as { args?: unknown; result?: unknown } | undefined;
				const toolCallId = String(tc.toolCallId ?? crypto.randomUUID());
				const bare = key ? key.replace(/ToolCall$/, '') : 'tool';
				const canonical = mapCursorToolName(bare);
				const input = normaliseToolInput(canonical, (inner?.args && typeof inner.args === 'object' ? inner.args : {}) as Record<string, unknown>, inner?.result);
				children.push(assistantMessage(toolUseBlock(toolCallId, canonical, input), true, agentToolId));
				children.push(toolResultMessage(toolCallId, extractResultText(inner?.result), false, agentToolId));
			}
		}
		return { children, finalText: finalText || extractResultText(result) };
	}

	function convert(message: SDKMessage): EngineOutput[] {
		switch (message.type) {
			case 'system': {
				const init: SystemInitEvent = {
					type: 'system_init',
					sessionId,
					model: message.model?.id ?? engine.model.id,
					engine: 'cursor',
					tools: message.tools ?? [],
					mcpServers: [],
				};
				return [init];
			}

			case 'user':
				// Echo of the prompt — the stream-manager persists the real user message.
				return [];

			case 'assistant': {
				const out: EngineOutput[] = [];
				let countedTurn = false;
				for (const block of message.message.content) {
					if (block.type === 'text') {
						if (!countedTurn) { turns += 1; countedTurn = true; }
						// Stream the chunk live + accumulate into ONE assistant message.
						if (block.text) out.push(...appendText(block.text));
					} else if (block.type === 'tool_use') {
						// A tool call ends the current text/reasoning block — flush first.
						out.push(...flushAll());
						const canonical = mapCursorToolName(block.name);
						emittedToolUse.add(block.id);
						const input = normaliseToolInput(canonical, (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>);
						out.push(assistantMessage(toolUseBlock(block.id, canonical, input), true));
					}
				}
				return out;
			}

			case 'thinking':
				// Stream the reasoning chunk live + accumulate into ONE reasoning message.
				return message.text ? appendReasoning(message.text) : [];

			case 'tool_call': {
				// A tool call ends the current text/reasoning block — flush first.
				const out: EngineOutput[] = flushAll();
				// Freeze the args now — Cursor mutates some in place (e.g. update_todos).
				const args = cloneArgs(message.args);
				const canonical = canonicalCursorTool(message.name, args);
				const terminal = message.status === 'completed' || message.status === 'error';

				// `create_plan` proposes a plan FOR THE USER TO READ. Render it as normal
				// assistant markdown (not an internal-looking tool card) so it's legible.
				if (canonical === 'ExitPlanMode') {
					if (terminal) {
						const plan = String((args as { plan?: unknown }).plan ?? '');
						if (plan.trim()) out.push(assistantMessage({ type: 'text', text: plan }, false));
					}
					return out;
				}

				// Surface the tool_use block ONCE. `edit` carries its before/after only
				// in the result diff, so defer its tool_use to completion; all other
				// tools emit on first sighting so the "running" state shows live.
				// AskUserQuestion is emitted separately via emitAskUserQuestion() with
				// the complete question set (stream args can arrive empty), so skip it here.
				const deferForResult = canonical === 'Edit';
				const skipToolUse = canonical === 'AskUserQuestion';
				if (!emittedToolUse.has(message.call_id) && !skipToolUse && (!deferForResult || terminal)) {
					emittedToolUse.add(message.call_id);
					const input = cursorToolInput(message.name, args, terminal ? message.result : undefined);
					out.push(assistantMessage(toolUseBlock(message.call_id, canonical, input), true));
				}

				if (terminal) {
					if (canonical === 'Agent') {
						// The sub-agent's steps stream live via onDelta taskUpdates
						// (emitSubagentActivity). Only replay from the result as a FALLBACK
						// when nothing was streamed. Always attach its final answer as the
						// Agent tool's result.
						const { children, finalText } = replaySubagent(message.result, message.call_id);
						if (!streamedSubagents.has(message.call_id)) out.push(...children);
						out.push(toolResultMessage(message.call_id, finalText, message.status === 'error'));
					} else {
						out.push(toolResultMessage(message.call_id, extractResultText(message.result), message.status === 'error'));
					}
				}
				return out;
			}

			case 'usage':
				lastUsage = mapUsage(message.usage);
				return [];

			default:
				return [];
		}
	}

	function finalize(result: RunResult): EngineOutput[] {
		// Flush any buffered reasoning/text as their consolidated messages.
		const out: EngineOutput[] = flushAll();
		if (result.usage) lastUsage = mapUsage(result.usage);
		const event: SuccessResultEvent = {
			type: 'result',
			subtype: 'success',
			sessionId,
			numTurns: turns,
			totalCostUsd: 0,
			usage: lastUsage ?? { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
			stopReason: result.status === 'cancelled' ? 'interrupted' : 'end_turn',
		};
		out.push(event);
		return out;
	}

	function emitAskUserQuestion(toolCallId: string, questions: AskUserQuestion[]): EngineOutput[] {
		const out: EngineOutput[] = flushAll();
		emittedToolUse.add(toolCallId);
		out.push(assistantMessage(toolUseBlock(toolCallId, 'AskUserQuestion', { questions: Array.isArray(questions) ? questions : [] }), true));
		return out;
	}

	function emitSubagentActivity(agentToolId: string, taskUpdate: unknown): EngineOutput[] {
		const tu = taskUpdate as { type?: string; callId?: string; toolCall?: { type?: string; args?: unknown; result?: unknown } };
		// Surface completed sub-agent tool calls (they carry both args + result) as
		// child tool_use + tool_result tagged with the Agent block id, so the
		// frontend folds them into subActivities as they happen.
		if (tu.type !== 'tool-call-completed' || !tu.toolCall) return [];
		streamedSubagents.add(agentToolId);
		const tc = tu.toolCall;
		const innerId = String(tu.callId ?? crypto.randomUUID());
		const args = (tc.args && typeof tc.args === 'object' ? tc.args : {}) as Record<string, unknown>;
		const name = tc.type ?? 'tool';
		const canonical = canonicalCursorTool(name, args);
		const input = cursorToolInput(name, args, tc.result);
		return [
			assistantMessage(toolUseBlock(innerId, canonical, input), true, agentToolId),
			toolResultMessage(innerId, extractResultText(tc.result), false, agentToolId),
		];
	}

	return { convert, finalize, emitAskUserQuestion, emitSubagentActivity };
}
