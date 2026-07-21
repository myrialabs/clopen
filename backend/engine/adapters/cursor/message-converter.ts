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
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';
import type { SDKMessage, RunResult, TokenUsage as CursorTokenUsage, InteractionUpdate } from '@cursor/sdk';
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

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Light per-tool input normalisation into the shared canonical shape. */
function normaliseToolInput(canonical: string, raw: Record<string, unknown>): Record<string, unknown> {
	switch (canonical) {
		case 'Read':
			return { filePath: String(raw.path ?? raw.file_path ?? raw.filePath ?? '') };
		case 'Write':
			return {
				filePath: String(raw.path ?? raw.file_path ?? raw.filePath ?? ''),
				content: String(raw.contents ?? raw.content ?? raw.text ?? ''),
			};
		case 'Edit':
			return {
				filePath: String(raw.path ?? raw.file_path ?? raw.filePath ?? ''),
				oldString: String(raw.old_string ?? raw.oldString ?? raw.old_str ?? ''),
				newString: String(raw.new_string ?? raw.newString ?? raw.new_str ?? ''),
			};
		case 'Bash':
			return { command: String(raw.command ?? raw.cmd ?? '') };
		case 'Grep':
			return {
				pattern: String(raw.pattern ?? raw.query ?? raw.regex ?? ''),
				...(raw.path != null ? { path: String(raw.path) } : {}),
			};
		case 'Glob':
			return { pattern: String(raw.pattern ?? raw.glob ?? raw.query ?? '') };
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

/** Extract plain text from a tool-call result payload (string / MCP content / object). */
function extractResultText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	const r = result as { content?: unknown; text?: unknown };
	if (typeof r.text === 'string') return r.text;
	if (Array.isArray(r.content)) {
		return r.content
			.map((c: unknown) => {
				const item = c as { type?: string; text?: string };
				return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
			})
			.filter(Boolean)
			.join('\n');
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
	/** Live token deltas (from `send({ onDelta })`) → transient stream_events. */
	convertDelta(update: InteractionUpdate): EngineOutput[];
	convert(message: SDKMessage): EngineOutput[];
	finalize(result: RunResult): EngineOutput[];
}

export function createCursorMessageConverter(options: CursorConverterOptions): CursorMessageConverter {
	const { engine, sessionId } = options;
	/** Tool-call ids already surfaced as a tool_use block (avoid duplicates). */
	const emittedToolUse = new Set<string>();
	let lastUsage: TokenUsage | null = null;
	let turns = 0;
	// Live-typing lifecycle flags — which delta stream is currently open.
	let textOpen = false;
	let reasoningOpen = false;

	/** Emit stop events for any open live-typing stream (before a persisted message). */
	function closeStreams(): StreamLifecycleEvent[] {
		const out: StreamLifecycleEvent[] = [];
		if (textOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false }); textOpen = false; }
		if (reasoningOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: true }); reasoningOpen = false; }
		return out;
	}

	/** Translate a live `onDelta` update into transient stream_events. */
	function convertDelta(update: InteractionUpdate): EngineOutput[] {
		switch (update.type) {
			case 'text-delta': {
				const out: EngineOutput[] = [];
				if (reasoningOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: true }); reasoningOpen = false; }
				if (!textOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent); textOpen = true; }
				out.push({ type: 'stream_event', event: 'delta', sessionId, text: update.text || '', reasoning: false } as TextDeltaEvent);
				return out;
			}
			case 'thinking-delta': {
				const out: EngineOutput[] = [];
				if (textOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false }); textOpen = false; }
				if (!reasoningOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent); reasoningOpen = true; }
				out.push({ type: 'stream_event', event: 'delta', sessionId, text: update.text || '', reasoning: true } as TextDeltaEvent);
				return out;
			}
			case 'thinking-completed':
				// Reasoning stream closed; the full ReasoningMessage arrives via `thinking`.
				if (reasoningOpen) { reasoningOpen = false; return [{ type: 'stream_event', event: 'stop', sessionId, reasoning: true }]; }
				return [];
			default:
				return [];
		}
	}

	function assistantMessage(block: ToolUseBlock | { type: 'text'; text: string }, isTool: boolean): AssistantMessage {
		return {
			type: 'assistant',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
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

	function toolResultMessage(toolUseId: string, content: string, isError: boolean): UserMessage {
		const block: UserContentBlock = { type: 'tool_result', toolUseId, content, isError };
		return {
			type: 'user',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine,
			sender: { id: '', name: '' },
			content: [block],
			synthetic: true,
		};
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
				turns += 1;
				const out: EngineOutput[] = closeStreams();
				for (const block of message.message.content) {
					if (block.type === 'text') {
						if (block.text.trim()) out.push(assistantMessage({ type: 'text', text: block.text }, false));
					} else if (block.type === 'tool_use') {
						const canonical = mapCursorToolName(block.name);
						emittedToolUse.add(block.id);
						const input = normaliseToolInput(canonical, (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>);
						out.push(assistantMessage(toolUseBlock(block.id, canonical, input), true));
					}
				}
				return out;
			}

			case 'thinking': {
				const out: EngineOutput[] = closeStreams();
				const text = (message.text ?? '').trim();
				if (!text) return out;
				const reasoning: ReasoningMessage = {
					type: 'reasoning',
					createdAt: new Date().toISOString(),
					messageId: crypto.randomUUID(),
					sessionId,
					parent: { messageId: null, sessionId: null, toolUseId: null },
					engine,
					text,
				};
				out.push(reasoning);
				return out;
			}

			case 'tool_call': {
				const out: EngineOutput[] = closeStreams();
				const canonical = mapCursorToolName(message.name);

				// Surface the tool_use block if the assistant message didn't already.
				if (!emittedToolUse.has(message.call_id)) {
					emittedToolUse.add(message.call_id);
					const input = normaliseToolInput(canonical, (message.args && typeof message.args === 'object' ? message.args : {}) as Record<string, unknown>);
					out.push(assistantMessage(toolUseBlock(message.call_id, canonical, input), true));
				}

				if (message.status === 'completed' || message.status === 'error') {
					out.push(toolResultMessage(message.call_id, extractResultText(message.result), message.status === 'error'));
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
		const out: EngineOutput[] = closeStreams();
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

	return { convertDelta, convert, finalize };
}
