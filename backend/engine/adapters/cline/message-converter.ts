/**
 * Cline SDK → Unified Type Converter.
 *
 * Translates `AgentRuntimeEvent`s (the `Agent`/`AgentRuntime` subscribe stream)
 * into `EngineOutput`. Cline is push/subscribe rather than an async generator, so
 * the engine bridges subscribe → generator and feeds each event through
 * `convert()` here (see ./stream.ts).
 *
 * Event mapping:
 *   - `assistant-text-delta` / `assistant-reasoning-delta` → live `stream_event`s
 *   - `assistant-message`                                  → ReasoningMessage + AssistantMessage(s)
 *   - `tool-finished`                                      → tool_result UserMessage
 *   - `usage-updated`                                      → accumulate totals
 *   - `run-finished`                                       → success ResultEvent
 *
 * Cline built-in tool names are snake_case (`read_files`, `run_commands`, …); we
 * canonicalise them to the unified PascalCase names + normalise input field names
 * so the shared tool UI renders identically to Claude/Codex. MCP tools already
 * arrive as `mcp__<server>__<tool>` from the bridge (see ./mcp-tools.ts).
 */

import type {
	AgentRuntimeEvent,
	AgentMessage,
	AgentMessagePart,
	AgentToolCallPart,
	AgentUsage,
	AgentModelFinishReason,
} from '@cline/agents';
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

const CLINE_TOOL_NAME_MAP: Record<string, string> = {
	read_files: 'Read',
	editor: 'Edit',
	run_commands: 'Bash',
	search_codebase: 'Grep',
	fetch_web_content: 'WebFetch',
	apply_patch: 'Patch',
	skills: 'Skill',
	ask_question: 'AskUserQuestion',
};

function canonicaliseToolName(rawName: string): string {
	if (rawName.startsWith('mcp__')) return rawName;
	return CLINE_TOOL_NAME_MAP[rawName] ?? rawName;
}

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Pull the first file path out of Cline's flexible read/edit file shapes. */
function firstPath(raw: Record<string, unknown>): string | undefined {
	const direct = (raw.filePath ?? raw.file_path ?? raw.path) as string | undefined;
	if (direct) return direct;
	const files = (raw.files ?? raw.paths) as unknown;
	if (Array.isArray(files) && files.length) {
		const f = files[0];
		if (typeof f === 'string') return f;
		if (f && typeof f === 'object') return ((f as Record<string, unknown>).path ?? (f as Record<string, unknown>).file_path ?? (f as Record<string, unknown>).filePath) as string | undefined;
	}
	return undefined;
}

function normaliseToolInput(canonical: string, raw: Record<string, unknown>): Record<string, unknown> {
	switch (canonical) {
		case 'Read': {
			const path = firstPath(raw);
			return { ...(path !== undefined ? { filePath: path } : {}) };
		}
		case 'Edit': {
			const path = firstPath(raw);
			const oldString = (raw.oldString ?? raw.old_text ?? raw.old_string ?? raw.oldText) as string | undefined;
			const newString = (raw.newString ?? raw.new_text ?? raw.new_string ?? raw.newText) as string | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(oldString !== undefined && oldString !== null ? { oldString } : {}),
				...(newString !== undefined ? { newString } : {}),
			};
		}
		case 'Bash': {
			const commands = raw.commands as unknown;
			let command: string | undefined;
			if (Array.isArray(commands)) command = commands.filter(c => typeof c === 'string').join(' && ');
			else command = (raw.command ?? raw.cmd) as string | undefined;
			return { ...(command ? { command } : {}) };
		}
		case 'Grep': {
			const queries = raw.queries as unknown;
			let pattern: string | undefined;
			if (Array.isArray(queries)) pattern = queries.filter(q => typeof q === 'string').join('|');
			else pattern = (raw.pattern ?? raw.query ?? raw.regex) as string | undefined;
			const path = (raw.path ?? raw.directory) as string | undefined;
			return { ...(pattern ? { pattern } : {}), ...(path !== undefined ? { path } : {}) };
		}
		case 'WebFetch': {
			const requests = raw.requests as unknown;
			let url: string | undefined;
			let prompt: string | undefined;
			if (Array.isArray(requests) && requests.length && typeof requests[0] === 'object') {
				const r = requests[0] as Record<string, unknown>;
				url = r.url as string | undefined;
				prompt = r.prompt as string | undefined;
			} else {
				url = raw.url as string | undefined;
				prompt = raw.prompt as string | undefined;
			}
			return { ...(url ? { url } : {}), ...(prompt ? { prompt } : {}) };
		}
		case 'Patch': {
			const patch = (raw.input ?? raw.patch ?? raw.diff) as string | undefined;
			const path = firstPath(raw);
			return { filePath: path ?? '', ...(patch ? { patch } : {}) };
		}
		case 'Skill': {
			const skill = (raw.skill ?? raw.name) as string | undefined;
			const args = (raw.args ?? undefined) as string | undefined;
			return { ...(skill ? { skill } : {}), ...(args ? { args } : {}) };
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

function mapFinishReason(raw: AgentModelFinishReason | null | undefined): StopReason | null {
	switch (raw) {
		case 'stop': return 'end_turn';
		case 'tool-calls': return 'tool_use';
		case 'max-tokens': return 'max_tokens';
		case 'aborted': return 'interrupted';
		case 'error': return 'end_turn';
		default: return null;
	}
}

function mapUsage(raw: Partial<AgentUsage> | null | undefined): TokenUsage {
	return {
		inputTokens: raw?.inputTokens ?? 0,
		outputTokens: raw?.outputTokens ?? 0,
		cacheCreationInputTokens: raw?.cacheWriteTokens ?? 0,
		cacheReadInputTokens: raw?.cacheReadTokens ?? 0,
	};
}

/** Extract plain text from a tool-result part output (string / MCP content / object). */
function extractResultText(output: unknown): string {
	if (output == null) return '';
	if (typeof output === 'string') return output;
	const r = output as { content?: unknown; text?: unknown };
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
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

// ============================================================
// Converter
// ============================================================

export interface ClineConverterOptions {
	engine: MessageEngine;
	sessionId: string;
}

export interface ClineMessageConverter {
	convert(event: AgentRuntimeEvent): EngineOutput[];
	readonly totalUsage: TokenUsage;
	readonly totalCostUsd: number;
	readonly turns: number;
}

export function createClineMessageConverter(options: ClineConverterOptions): ClineMessageConverter {
	const { engine, sessionId } = options;
	let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	let totalCostUsd = 0;
	let turns = 0;
	let emittedContent = false;
	// Live-typing lifecycle flags — which delta stream is currently open.
	let textOpen = false;
	let reasoningOpen = false;

	function closeStreams(): StreamLifecycleEvent[] {
		const out: StreamLifecycleEvent[] = [];
		if (textOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false }); textOpen = false; }
		if (reasoningOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: true }); reasoningOpen = false; }
		return out;
	}

	function mapAssistantContent(parts: readonly AgentMessagePart[]): { reasoning: string; blocks: AssistantContentBlock[] } {
		let reasoning = '';
		const blocks: AssistantContentBlock[] = [];
		for (const part of parts) {
			if (part.type === 'reasoning') {
				if (part.text) reasoning += (reasoning ? '\n' : '') + part.text;
			} else if (part.type === 'text') {
				if (part.text.trim()) blocks.push({ type: 'text', text: part.text });
			} else if (part.type === 'tool-call') {
				const call = part as AgentToolCallPart;
				const canonical = canonicaliseToolName(call.toolName);
				const finalName = toCanonicalToolName(canonical);
				const rawInput = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
				blocks.push({
					type: 'tool_use',
					id: call.toolCallId,
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

	function convertAssistantMessage(msg: AgentMessage, finishReason: AgentModelFinishReason): EngineOutput[] {
		const outputs: EngineOutput[] = [];
		const { reasoning, blocks } = mapAssistantContent(msg.content);
		const usage = msg.metrics ? mapUsage(msg.metrics) : null;

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

		if (blocks.length === 0) return outputs;
		emittedContent = true;

		const baseId = crypto.randomUUID();
		if (blocks.length === 1) {
			outputs.push({
				type: 'assistant',
				createdAt: new Date().toISOString(),
				messageId: baseId,
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: null },
				engine,
				content: blocks,
				stopReason: blocks[0].type === 'tool_use' ? 'tool_use' : mapFinishReason(finishReason),
				usage,
			} as AssistantMessage);
		} else {
			// One tool_use per AssistantMessage (README §10.3).
			blocks.forEach((block, idx) => {
				outputs.push({
					type: 'assistant',
					createdAt: new Date().toISOString(),
					messageId: `${baseId}:${idx}`,
					sessionId,
					parent: { messageId: null, sessionId: null, toolUseId: null },
					engine,
					content: [block],
					stopReason: block.type === 'tool_use' ? 'tool_use' : mapFinishReason(finishReason),
					usage: idx === blocks.length - 1 ? usage : null,
				} as AssistantMessage);
			});
		}
		return outputs;
	}

	function convertToolResults(msg: AgentMessage): UserMessage[] {
		const out: UserMessage[] = [];
		for (const part of msg.content) {
			if (part.type !== 'tool-result') continue;
			emittedContent = true;
			out.push({
				type: 'user',
				createdAt: new Date().toISOString(),
				messageId: crypto.randomUUID(),
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: null },
				engine,
				sender: { id: '', name: '' },
				content: [{ type: 'tool_result', toolUseId: part.toolCallId, content: extractResultText(part.output), isError: !!part.isError }],
				synthetic: true,
			});
		}
		return out;
	}

	function convert(event: AgentRuntimeEvent): EngineOutput[] {
		switch (event.type) {
			case 'assistant-text-delta': {
				const out: EngineOutput[] = [];
				if (reasoningOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: true }); reasoningOpen = false; }
				if (!textOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent); textOpen = true; }
				out.push({ type: 'stream_event', event: 'delta', sessionId, text: event.text || '', reasoning: false } as TextDeltaEvent);
				return out;
			}
			case 'assistant-reasoning-delta': {
				const out: EngineOutput[] = [];
				if (textOpen) { out.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: false }); textOpen = false; }
				if (!reasoningOpen) { out.push({ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent); reasoningOpen = true; }
				out.push({ type: 'stream_event', event: 'delta', sessionId, text: event.text || '', reasoning: true } as TextDeltaEvent);
				return out;
			}
			case 'assistant-message': {
				turns += 1;
				const out: EngineOutput[] = [...closeStreams()];
				out.push(...convertAssistantMessage(event.message, event.finishReason));
				return out;
			}
			case 'tool-finished':
				return convertToolResults(event.message);
			case 'usage-updated': {
				totalUsage = mapUsage(event.usage);
				if (typeof event.usage.totalCost === 'number') totalCostUsd = event.usage.totalCost;
				return [];
			}
			case 'run-finished': {
				const outputs: EngineOutput[] = [...closeStreams()];
				if (event.result?.usage) {
					totalUsage = mapUsage(event.result.usage);
					if (typeof event.result.usage.totalCost === 'number') totalCostUsd = event.result.usage.totalCost;
				}
				if (!emittedContent) {
					outputs.push({
						type: 'notification',
						sessionId,
						level: 'warning',
						title: 'Empty response',
						message: 'Cline returned an empty response. Try again or rephrase your prompt.',
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
