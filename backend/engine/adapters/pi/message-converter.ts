/**
 * Pi SDK → Unified Type Converter.
 *
 * Translates `AgentSessionEvent`s (pi-coding-agent's subscribe stream) into
 * `EngineOutput`. Unlike the other adapters, Pi is push/subscribe rather than an
 * async generator, so the engine bridges subscribe → generator and feeds each
 * event through `convert()` here (see ./stream.ts).
 *
 * Event mapping:
 *   - `message_update` (text/thinking deltas) → live `stream_event`s
 *   - `message_end` (assistant)              → ReasoningMessage + AssistantMessage(s)
 *   - `tool_execution_end`                   → tool_result UserMessage
 *   - `agent_end`                            → success ResultEvent
 *
 * Pi built-in tool names are lowercase (`read`, `bash`, …); we canonicalise them
 * to the unified PascalCase names + normalise input field names so the shared
 * tool UI renders identically to Claude/Codex. MCP tools already arrive as
 * `mcp__<server>__<tool>` from the bridge (see ./mcp-tools.ts).
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type {
	AssistantMessage as PiAssistantMessage,
	ToolCall as PiToolCall,
	Usage as PiUsage,
	StopReason as PiStopReason,
} from '@earendil-works/pi-ai';
import type {
	MessageEngine,
	EngineOutput,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	AssistantContentBlock,
	ToolUseBlock,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	NotificationEvent,
	TokenUsage,
	StopReason,
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';

// ============================================================
// Tool name + input normalisation
// ============================================================

const PI_TOOL_NAME_MAP: Record<string, string> = {
	read: 'Read',
	bash: 'Bash',
	edit: 'Edit',
	write: 'Write',
	grep: 'Grep',
	glob: 'Glob',
	find: 'Glob',
	ls: 'List',
	list: 'List',
	ask_question: 'AskUserQuestion',
};

function canonicaliseToolName(rawName: string): string {
	if (rawName.startsWith('mcp__')) return rawName;
	return PI_TOOL_NAME_MAP[rawName] ?? rawName;
}

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normaliseToolInput(canonical: string, raw: Record<string, unknown>): Record<string, unknown> {
	switch (canonical) {
		case 'Read': {
			const path = (raw.filePath ?? raw.file_path ?? raw.path ?? raw.absolute_path) as string | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(raw.offset !== undefined ? { offset: raw.offset } : {}),
				...(raw.limit !== undefined ? { limit: raw.limit } : {}),
			};
		}
		case 'Write': {
			const path = (raw.filePath ?? raw.file_path ?? raw.path) as string | undefined;
			const content = (raw.content ?? raw.text) as string | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(content !== undefined ? { content } : {}),
			};
		}
		case 'Edit': {
			const path = (raw.path ?? raw.filePath ?? raw.file_path) as string | undefined;
			// Pi's edit tool is multi-edit: `{ path, edits: [{ oldText, newText }] }`.
			// The unified UI renders a single old→new diff, so fold the hunks: one
			// edit maps directly; several are joined so the content still shows.
			let oldString: string | undefined;
			let newString: string | undefined;
			const edits = Array.isArray(raw.edits) ? (raw.edits as Array<{ oldText?: string; newText?: string }>) : null;
			if (edits && edits.length > 0) {
				oldString = edits.map(e => e.oldText ?? '').join('\n');
				newString = edits.map(e => e.newText ?? '').join('\n');
			} else {
				oldString = (raw.oldString ?? raw.old_string ?? raw.oldText ?? raw.old_text) as string | undefined;
				newString = (raw.newString ?? raw.new_string ?? raw.newText ?? raw.new_text) as string | undefined;
			}
			const replaceAll = (raw.replaceAll ?? raw.replace_all) as boolean | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(oldString !== undefined ? { oldString } : {}),
				...(newString !== undefined ? { newString } : {}),
				...(replaceAll !== undefined ? { replaceAll: !!replaceAll } : {}),
			};
		}
		case 'Bash': {
			const command = (raw.command ?? raw.cmd ?? raw.script) as string | undefined;
			const description = (raw.description ?? raw.reason) as string | undefined;
			return {
				...(command !== undefined ? { command } : {}),
				...(description !== undefined ? { description } : {}),
			};
		}
		case 'Grep': {
			const pattern = (raw.pattern ?? raw.regex ?? raw.query) as string | undefined;
			const path = (raw.path ?? raw.directory) as string | undefined;
			return {
				...(pattern !== undefined ? { pattern } : {}),
				...(path !== undefined ? { path } : {}),
			};
		}
		case 'Glob': {
			const pattern = (raw.pattern ?? raw.glob ?? raw.query) as string | undefined;
			const path = (raw.path ?? raw.directory) as string | undefined;
			return {
				...(pattern !== undefined ? { pattern } : {}),
				...(path !== undefined ? { path } : {}),
			};
		}
		case 'List': {
			const path = (raw.path ?? raw.directory ?? raw.dir) as string | undefined;
			return { ...(path !== undefined ? { path } : {}) };
		}
		case 'AskUserQuestion': {
			return { questions: Array.isArray(raw.questions) ? raw.questions : [] };
		}
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

function mapStopReason(raw: PiStopReason | null | undefined): StopReason | null {
	switch (raw) {
		case 'stop': return 'end_turn';
		case 'toolUse': return 'tool_use';
		case 'length': return 'max_tokens';
		case 'aborted': return 'interrupted';
		case 'error': return 'end_turn';
		default: return null;
	}
}

function mapUsage(raw: PiUsage | null | undefined): TokenUsage | null {
	if (!raw) return null;
	return {
		inputTokens: raw.input || 0,
		outputTokens: raw.output || 0,
		cacheCreationInputTokens: raw.cacheWrite || 0,
		cacheReadInputTokens: raw.cacheRead || 0,
	};
}

// ============================================================
// Converter
// ============================================================

export interface PiConverterOptions {
	engine: MessageEngine;
	sessionId: string;
}

export interface PiMessageConverter {
	convert(event: AgentSessionEvent): EngineOutput[];
	/** Accumulated usage for the final result event. */
	readonly totalUsage: TokenUsage;
	readonly totalCostUsd: number;
	readonly turns: number;
}

export function createPiMessageConverter(options: PiConverterOptions): PiMessageConverter {
	const { engine, sessionId } = options;
	const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	let totalCostUsd = 0;
	let turns = 0;
	// Tracks whether the run produced ANY visible output (reasoning, assistant
	// text/tool_use, or a tool result). If a whole run ends with nothing — e.g.
	// the model returns an empty end_turn — we surface a notification on
	// `agent_end` instead of leaving the user staring at silence.
	let emittedContent = false;

	function mapAssistantContent(msg: PiAssistantMessage): { reasoning: string; blocks: AssistantContentBlock[] } {
		let reasoning = '';
		const blocks: AssistantContentBlock[] = [];
		for (const block of msg.content) {
			if (block.type === 'thinking') {
				reasoning += (reasoning ? '\n' : '') + block.thinking;
			} else if (block.type === 'text') {
				// Skip empty/whitespace text blocks. Gemini (and others) routinely
				// emit a trailing empty text part after a tool call; persisting it
				// would render as a blank assistant bubble.
				if (block.text.trim()) blocks.push({ type: 'text', text: block.text });
			} else if (block.type === 'toolCall') {
				const call = block as PiToolCall;
				const canonical = canonicaliseToolName(call.name);
				const finalName = toCanonicalToolName(canonical);
				const rawInput = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<string, unknown>;
				blocks.push({
					type: 'tool_use',
					id: call.id,
					name: finalName,
					input: normaliseToolInput(canonical, rawInput),
					result: null,
					subActivities: [],
					skillPrompt: null,
					interrupted: false,
				} as ToolUseBlock);
			}
		}
		return { reasoning, blocks };
	}

	function convertAssistantMessage(msg: PiAssistantMessage): EngineOutput[] {
		const outputs: EngineOutput[] = [];
		const { reasoning, blocks } = mapAssistantContent(msg);

		if (reasoning.trim()) {
			emittedContent = true;
			outputs.push({
				type: 'reasoning',
				createdAt: new Date().toISOString(),
				messageId: crypto.randomUUID(),
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: null },
				engine,
				text: reasoning,
			} as ReasoningMessage);
		}

		const usage = mapUsage(msg.usage);
		if (msg.usage) {
			totalUsage.inputTokens += msg.usage.input || 0;
			totalUsage.outputTokens += msg.usage.output || 0;
			totalUsage.cacheCreationInputTokens += msg.usage.cacheWrite || 0;
			totalUsage.cacheReadInputTokens += msg.usage.cacheRead || 0;
			totalCostUsd += msg.usage.cost?.total || 0;
		}

		// Nothing substantive in this message. If the model genuinely errored
		// (stopReason 'error' with a message), surface a CLEANED message as visible
		// text; user-aborted turns and empty responses emit no bubble — an empty
		// text placeholder just looks like a stuck turn.
		if (blocks.length === 0) {
			const errorMessage = (msg as { errorMessage?: string }).errorMessage;
			if (msg.stopReason === 'error' && errorMessage && errorMessage.trim()) {
				emittedContent = true;
				outputs.push({
					type: 'assistant',
					createdAt: new Date().toISOString(),
					messageId: crypto.randomUUID(),
					sessionId,
					parent: { messageId: null, sessionId: null, toolUseId: null },
					engine,
					content: [{ type: 'text', text: `⚠️ ${cleanProviderError(errorMessage)}` }],
					stopReason: mapStopReason(msg.stopReason),
					usage,
				} as AssistantMessage);
			}
			return outputs;
		}
		emittedContent = true;

		const emitBlocks = blocks;
		const baseId = crypto.randomUUID();
		if (emitBlocks.length === 1) {
			outputs.push({
				type: 'assistant',
				createdAt: new Date().toISOString(),
				messageId: baseId,
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: null },
				engine,
				content: emitBlocks,
				stopReason: emitBlocks[0].type === 'tool_use' ? 'tool_use' : mapStopReason(msg.stopReason),
				usage,
			} as AssistantMessage);
		} else {
			// One tool_use per AssistantMessage (README §10.3).
			emitBlocks.forEach((block, idx) => {
				outputs.push({
					type: 'assistant',
					createdAt: new Date().toISOString(),
					messageId: `${baseId}:${idx}`,
					sessionId,
					parent: { messageId: null, sessionId: null, toolUseId: null },
					engine,
					content: [block],
					stopReason: block.type === 'tool_use' ? 'tool_use' : mapStopReason(msg.stopReason),
					usage: idx === emitBlocks.length - 1 ? usage : null,
				} as AssistantMessage);
			});
		}
		return outputs;
	}

	function convertToolResult(toolCallId: string, result: unknown, isError: boolean): UserMessage {
		emittedContent = true;
		const text = extractResultText(result);
		return {
			type: 'user',
			createdAt: new Date().toISOString(),
			messageId: crypto.randomUUID(),
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine,
			sender: { id: '', name: '' },
			content: [{ type: 'tool_result', toolUseId: toolCallId, content: text, isError }],
			synthetic: true,
		};
	}

	function convert(event: AgentSessionEvent): EngineOutput[] {
		switch (event.type) {
			case 'message_update': {
				const ev = event.assistantMessageEvent;
				switch (ev.type) {
					case 'text_start':
						return [{ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent];
					case 'text_delta':
						return [{ type: 'stream_event', event: 'delta', sessionId, text: ev.delta || '', reasoning: false } as TextDeltaEvent];
					case 'text_end':
						return [{ type: 'stream_event', event: 'stop', sessionId, reasoning: false } as StreamLifecycleEvent];
					case 'thinking_start':
						return [{ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent];
					case 'thinking_delta':
						return [{ type: 'stream_event', event: 'delta', sessionId, text: ev.delta || '', reasoning: true } as TextDeltaEvent];
					case 'thinking_end':
						return [{ type: 'stream_event', event: 'stop', sessionId, reasoning: true } as StreamLifecycleEvent];
					default:
						return [];
				}
			}
			case 'message_end': {
				const msg = event.message;
				if (msg && (msg as { role?: string }).role === 'assistant') {
					turns += 1;
					return convertAssistantMessage(msg as PiAssistantMessage);
				}
				return [];
			}
			case 'tool_execution_end':
				return [convertToolResult(event.toolCallId, event.result, event.isError)];
			case 'agent_end': {
				const outputs: EngineOutput[] = [];
				// Run produced no visible output at all → tell the user rather than
				// finishing silently (looks like a stuck / dropped turn otherwise).
				if (!emittedContent) {
					outputs.push({
						type: 'notification',
						sessionId,
						level: 'warning',
						title: 'Empty response',
						message: 'Pi returned an empty response. Try again or rephrase your prompt.',
					} as NotificationEvent);
				}
				outputs.push({
					type: 'result',
					subtype: 'success',
					sessionId,
					numTurns: turns,
					totalCostUsd,
					usage: { ...totalUsage },
					stopReason: null,
				} as SuccessResultEvent);
				return outputs;
			}
			default:
				return [];
		}
	}

	return {
		convert,
		get totalUsage() { return totalUsage; },
		get totalCostUsd() { return totalCostUsd; },
		get turns() { return turns; },
	};
}

/**
 * Turn a provider error (often a doubly-encoded JSON envelope with literal
 * `\n`s — e.g. Google's 429 quota blob) into a short human-readable line.
 */
function cleanProviderError(raw: string): string {
	let msg = raw.trim();
	// Peel nested `{ error: { message } }` / `{ message }` envelopes.
	for (let i = 0; i < 3; i++) {
		try {
			const parsed = JSON.parse(msg) as { error?: { message?: string; code?: number; status?: string }; message?: string };
			const inner = parsed?.error?.message ?? parsed?.message;
			if (typeof inner === 'string' && inner.trim()) { msg = inner.trim(); continue; }
		} catch {
			break;
		}
		break;
	}
	// Collapse escaped/real whitespace and trim to one tidy line.
	msg = msg.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
	if (/quota|rate limit|resource_exhausted|429/i.test(msg)) {
		msg = `Rate limit / quota exceeded — ${msg}`;
	}
	return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

/** Extract plain text from a tool result (AgentToolResult or MCP-style content). */
function extractResultText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	const r = result as { content?: unknown };
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
