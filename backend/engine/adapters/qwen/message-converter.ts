/**
 * Qwen Code SDK → Unified Type Converters
 *
 * Translates `@qwen-code/sdk` messages (whose shape closely mirrors the
 * Anthropic content-block model) into `EngineOutput` (unified types).
 *
 * Mirrors `claude/message-converter.ts` — the message envelope is identical
 * (SDKAssistantMessage / SDKUserMessage / SDKPartialAssistantMessage with
 * text / thinking / tool_use / tool_result blocks). Differences from Claude:
 *
 * 1. **Tool names are gemini-cli style snake_case** (`read_file`, `write_file`,
 *    `replace`, `run_shell_command`, …). We map them to the canonical
 *    PascalCase names so the existing tool UI components render correctly,
 *    then normalise input shapes (`file_path` → `filePath`, etc.).
 * 2. **Stop reasons are free-form strings** (the Anthropic-style values aren't
 *    guaranteed). We keep the strict union via best-effort mapping.
 * 3. **Provider/account on every emitted message** is filled from per-stream
 *    state — there is no SDK-level "provider" hint.
 */

import type {
	SDKMessage,
	SDKAssistantMessage,
	SDKUserMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKResultMessageSuccess,
	SDKResultMessageError,
	SDKSystemMessage,
	ContentBlock as QwenContentBlock,
	Usage as QwenUsage,
	ExtendedUsage as QwenExtendedUsage,
} from '@qwen-code/sdk';
import type {
	MessageEngine,
	EngineOutput,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	UserContentBlock,
	AssistantContentBlock,
	ToolUseBlock,
	ToolResult,
	TextDeltaEvent,
	StreamLifecycleEvent,
	SuccessResultEvent,
	ErrorResultEvent,
	SystemInitEvent,
	TokenUsage,
	StopReason,
	AskUserQuestion,
} from '$shared/types/unified';
import { toCanonicalToolName } from '$shared/types/unified';
import { resolveOpenCodeToolName } from '../../../mcp';

// ============================================================
// Qwen-specific tool-result content markers
//
// Two strings come back from `agent` tool execution that mean "the sub-agent
// has only just been spawned — its real output is still pending":
//
// 1. FORK_PLACEHOLDER_RESULT — fire-and-forget fork (no `subagent_type`,
//    no `run_in_background`). Source: `node_modules/@qwen-code/sdk/dist/cli/cli.js:277525`.
// 2. The "Background agent launched successfully…" multiline blob —
//    `run_in_background: true` mode that emits a `task_notification` later.
//    Source: same file around line 281616.
//
// We intercept these so the Agent block stays in the "pending" state in the
// UI while sub-activities accumulate, then emit a synthetic tool_result with
// the actual sub-agent output when we can.
// ============================================================
const QWEN_FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background';
const QWEN_BACKGROUND_LAUNCH_PREFIX = 'Background agent launched successfully.';

function isQwenAgentPlaceholderResult(content: string): boolean {
	const trimmed = content.trim();
	return trimmed === QWEN_FORK_PLACEHOLDER_RESULT
		|| trimmed.startsWith(QWEN_BACKGROUND_LAUNCH_PREFIX);
}

/**
 * Format the user's answers to AskUserQuestion in OpenCode's wording so the
 * downstream model sees a consistent payload regardless of which engine ran.
 * Mirrors the OpenCode adapter's output:
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user's answers in mind.`
 *
 * Qwen's `answers` map is keyed by question INDEX (string number), not by
 * question text — see `node_modules/@qwen-code/sdk/dist/cli/cli.js:284219-284222`.
 * We dereference each index against the original questions array.
 */
function formatAskUserQuestionResult(questions: AskUserQuestion[], answers: Record<string, string>): string {
	const pairs: string[] = [];
	for (const [key, value] of Object.entries(answers)) {
		const idx = Number.parseInt(key, 10);
		const q = Number.isFinite(idx) ? questions[idx] : undefined;
		const label = q?.question ?? q?.header ?? `Question ${key}`;
		pairs.push(`"${label}"="${value}"`);
	}
	if (pairs.length === 0) {
		return 'User did not provide any answers.';
	}
	return `User has answered your questions: ${pairs.join(', ')}. You can now continue with the user's answers in mind.`;
}

// ============================================================
// Engine identity
// ============================================================

export function buildEngine(modelId: string): MessageEngine {
	return {
		type: 'qwen',
		provider: 'qwen',
		model: { id: modelId, name: '' },
		account: { id: 0, name: '' },
	};
}

// ============================================================
// Helper mappers
// ============================================================

function mapStopReason(raw: string | null | undefined): StopReason | null {
	switch (raw) {
		case 'end_turn':
		case 'stop':
		case 'finish':
			return 'end_turn';
		case 'tool_use':
		case 'tool_calls':
			return 'tool_use';
		case 'max_tokens':
		case 'length':
			return 'max_tokens';
		case 'interrupted':
		case 'cancelled':
			return 'interrupted';
		default:
			return raw ? 'end_turn' : null;
	}
}

function mapUsage(raw: QwenUsage | QwenExtendedUsage | null | undefined): TokenUsage | null {
	if (!raw) return null;
	return {
		inputTokens: raw.input_tokens || 0,
		outputTokens: raw.output_tokens || 0,
		cacheCreationInputTokens: raw.cache_creation_input_tokens || 0,
		cacheReadInputTokens: raw.cache_read_input_tokens || 0,
	};
}

function mapUsageRequired(raw: QwenUsage | QwenExtendedUsage | null | undefined): TokenUsage {
	const usage = mapUsage(raw);
	if (usage) return usage;
	return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

// ============================================================
// Tool name + input normalisation
//
// Qwen Code is built on gemini-cli, so its tool surface uses snake_case
// names. We canonicalise both the name and the input fields so the existing
// tool UI components render the same way they do for Claude / Codex.
// ============================================================

/**
 * Map Qwen Code's snake_case tool names to the canonical PascalCase names
 * the unified UI components render. Sourced from the bundled CLI's
 * `ToolNames` table — `agent` (not `task`) is the dispatch tool, and
 * `grep_search` is the active grep variant in v0.1.7+.
 */
const QWEN_TOOL_NAME_MAP: Record<string, string> = {
	// File I/O
	'read_file': 'Read',
	'write_file': 'Write',
	'replace': 'Edit',
	'edit': 'Edit',
	// Listing / search
	'list_directory': 'List',
	'ls': 'List',
	'glob': 'Glob',
	'grep_search': 'Grep',
	'search_file_content': 'Grep',
	'grep': 'Grep',
	// Shell
	'run_shell_command': 'Bash',
	'shell': 'Bash',
	'execute': 'Bash',
	// Web
	'web_fetch': 'WebFetch',
	'google_web_search': 'WebSearch',
	'web_search': 'WebSearch',
	// Memory / planning
	'todo_write': 'TodoWrite',
	'save_memory': 'TodoWrite',
	'exit_plan_mode': 'ExitPlanMode',
	// Sub-agent dispatch
	'agent': 'Agent',
	'task': 'Agent',
	'dispatch_agent': 'Agent',
	'task_stop': 'TaskStop',
	// Question / harness
	'ask_user_question': 'AskUserQuestion',
	'skill': 'Skill',
	'lsp': 'Lsp',
	// Cron
	'cron_create': 'CronCreate',
	'cron_list': 'CronList',
	'cron_delete': 'CronDelete',
	// `send_message` is the Qwen-specific channel the parent uses to push a
	// follow-up prompt into a backgrounded sub-agent. There's no canonical
	// equivalent — keep its raw name so the UI renders it as Unknown:* rather
	// than silently swallowing the call.
};

function canonicaliseToolName(rawName: string): string {
	// MCP tools come through as `clopen-mcp_<tool>` or `clopen-mcp-<tool>` —
	// route through the shared resolver so they collapse to the canonical
	// `mcp__<server>__<tool>` form (README §10.12).
	const resolved = resolveOpenCodeToolName(rawName);
	if (resolved) return resolved;

	const mapped = QWEN_TOOL_NAME_MAP[rawName];
	if (mapped) return mapped;
	// Already canonical (PascalCase) — let toCanonicalToolName decide.
	return rawName;
}

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Per-tool input normalisers — Qwen exposes gemini-cli's snake_case fields
 * which the unified UI types expect in camelCase.
 */
function normaliseToolInput(canonical: string, raw: Record<string, unknown>): Record<string, unknown> {
	switch (canonical) {
		case 'Read': {
			const path = (raw.absolute_path ?? raw.file_path ?? raw.path ?? raw.filePath) as string | undefined;
			const offset = raw.offset as number | undefined;
			const limit = raw.limit as number | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(offset !== undefined ? { offset } : {}),
				...(limit !== undefined ? { limit } : {}),
			};
		}
		case 'Write': {
			const path = (raw.file_path ?? raw.path ?? raw.filePath ?? raw.absolute_path) as string | undefined;
			const content = (raw.content ?? raw.text ?? raw.contents) as string | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(content !== undefined ? { content } : {}),
			};
		}
		case 'Edit': {
			const path = (raw.file_path ?? raw.path ?? raw.filePath ?? raw.absolute_path) as string | undefined;
			const oldString = (raw.old_string ?? raw.oldString ?? raw.search) as string | undefined;
			const newString = (raw.new_string ?? raw.newString ?? raw.replace) as string | undefined;
			const replaceAll = (raw.expected_replacements ?? raw.replaceAll) as number | boolean | undefined;
			return {
				...(path !== undefined ? { filePath: path } : {}),
				...(oldString !== undefined ? { oldString } : {}),
				...(newString !== undefined ? { newString } : {}),
				...(replaceAll !== undefined ? { replaceAll: typeof replaceAll === 'number' ? replaceAll > 1 : !!replaceAll } : {}),
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
		case 'List': {
			const path = (raw.path ?? raw.directory ?? raw.absolute_path ?? raw.filePath) as string | undefined;
			return { ...(path !== undefined ? { path } : {}) };
		}
		case 'Glob': {
			const pattern = (raw.pattern ?? raw.glob) as string | undefined;
			const path = (raw.path ?? raw.directory) as string | undefined;
			return {
				...(pattern !== undefined ? { pattern } : {}),
				...(path !== undefined ? { path } : {}),
			};
		}
		case 'Grep': {
			const pattern = (raw.pattern ?? raw.regex ?? raw.query) as string | undefined;
			const path = (raw.path ?? raw.directory) as string | undefined;
			const include = (raw.include ?? raw.glob) as string | undefined;
			return {
				...(pattern !== undefined ? { pattern } : {}),
				...(path !== undefined ? { path } : {}),
				...(include !== undefined ? { glob: include } : {}),
			};
		}
		case 'WebFetch': {
			const url = raw.url as string | undefined;
			const prompt = (raw.prompt ?? raw.query ?? raw.task) as string | undefined;
			return {
				...(url !== undefined ? { url } : {}),
				...(prompt !== undefined ? { prompt } : {}),
			};
		}
		case 'WebSearch': {
			const query = (raw.query ?? raw.q) as string | undefined;
			return { ...(query !== undefined ? { query } : {}) };
		}
		case 'TodoWrite': {
			const todos = raw.todos ?? raw.items;
			if (Array.isArray(todos)) {
				const normalised = todos.map((t: unknown) => {
					const todo = t as Record<string, unknown>;
					return {
						content: (todo.content ?? todo.text ?? todo.description ?? '') as string,
						status: (todo.status ?? (todo.completed ? 'completed' : 'pending')) as string,
						activeForm: (todo.activeForm ?? todo.active_form ?? todo.content ?? '') as string,
					};
				});
				return { todos: normalised };
			}
			return { todos: [] };
		}
		case 'Agent': {
			const subagentType = (raw.subagent_type ?? raw.agent_type ?? raw.agent ?? raw.name) as string | undefined;
			const description = (raw.description ?? raw.task) as string | undefined;
			const prompt = (raw.prompt ?? raw.instruction ?? raw.task) as string | undefined;
			return {
				...(prompt !== undefined ? { prompt } : {}),
				...(description !== undefined ? { description } : {}),
				subagentType: subagentType ?? 'general-purpose',
			};
		}
		case 'AskUserQuestion': {
			// Qwen's schema matches the unified shape closely — just pass `questions`
			// through, defaulting to [] if absent so the UI renders an empty prompt
			// instead of crashing.
			const questions = Array.isArray(raw.questions) ? raw.questions : [];
			return { questions };
		}
		case 'ExitPlanMode': {
			// Qwen ships only `{ plan: string }`; the unified type's optional
			// `allowedPrompts` field is unused. Pass `plan` through verbatim — the
			// UI variants read it via `(input as Record<string,unknown>).plan`.
			const plan = (raw.plan ?? raw.summary ?? raw.text) as string | undefined;
			return plan !== undefined ? { plan } : {};
		}
		case 'Skill': {
			const skill = (raw.skill ?? raw.name ?? raw.id) as string | undefined;
			const args = (raw.args ?? raw.arguments ?? raw.input) as string | undefined;
			return {
				skill: skill ?? '',
				...(args !== undefined ? { args } : {}),
			};
		}
		case 'Lsp': {
			const operation = (raw.operation ?? raw.action ?? raw.method) as string | undefined;
			const filePath = (raw.file_path ?? raw.filePath ?? raw.path) as string | undefined;
			const line = (raw.line ?? raw.lineNumber) as number | undefined;
			const column = (raw.column ?? raw.col) as number | undefined;
			const symbol = (raw.symbol ?? raw.name ?? raw.identifier) as string | undefined;
			return {
				operation: operation ?? '',
				...(filePath !== undefined ? { filePath } : {}),
				...(line !== undefined ? { line } : {}),
				...(column !== undefined ? { column } : {}),
				...(symbol !== undefined ? { symbol } : {}),
			};
		}
		case 'CronCreate': {
			const name = (raw.name ?? raw.title) as string | undefined;
			const schedule = (raw.schedule ?? raw.cron ?? raw.expression) as string | undefined;
			const prompt = (raw.prompt ?? raw.instruction ?? raw.task) as string | undefined;
			const description = (raw.description ?? raw.summary) as string | undefined;
			return {
				name: name ?? '',
				schedule: schedule ?? '',
				prompt: prompt ?? '',
				...(description !== undefined ? { description } : {}),
			};
		}
		case 'CronList': {
			const filter = (raw.filter ?? raw.query) as string | undefined;
			return filter !== undefined ? { filter } : {};
		}
		case 'CronDelete': {
			const id = (raw.id ?? raw.cron_id ?? raw.cronId ?? raw.name) as string | undefined;
			return { id: id ?? '' };
		}
		case 'TaskStop': {
			const taskId = (raw.task_id ?? raw.taskId ?? raw.id) as string | undefined;
			return { taskId: taskId ?? '' };
		}
		default: {
			// Generic snake → camel passthrough so unknown fields still render.
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(raw)) {
				out[snakeToCamel(k)] = v;
			}
			return out;
		}
	}
}

// ============================================================
// Content block converters
// ============================================================

function mapAssistantContent(content: QwenContentBlock[], state?: QwenConverterState, sessionId?: string): AssistantContentBlock[] {
	const blocks: AssistantContentBlock[] = [];
	for (const block of content) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: block.text });
				break;
			case 'tool_use': {
				const canonical = canonicaliseToolName(block.name);
				const rawInput = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
				const normalisedInput = normaliseToolInput(canonical, rawInput);
				const finalName = toCanonicalToolName(canonical);
				if (finalName === 'AskUserQuestion') {
					state?.onAskUserQuestionEmitted?.(block.id);
					if (state) {
						const questions = (normalisedInput.questions as AskUserQuestion[] | undefined) ?? [];
						state.askUserQuestions.set(block.id, {
							questions,
							answered: false,
							answers: null,
							sessionId: sessionId ?? null,
						});
					}
				} else if (finalName === 'Agent' && state) {
					const description = (normalisedInput.description as string | undefined) ?? '';
					state.pendingAgents.set(block.id, {
						accumulatedText: '',
						description,
						sessionId: sessionId ?? null,
					});
				}
				blocks.push({
					type: 'tool_use',
					id: block.id,
					name: finalName,
					input: normalisedInput,
					result: null,
					subActivities: [],
					skillPrompt: null,
					interrupted: false,
				} as ToolUseBlock);
				break;
			}
			// thinking/tool_result do not appear on assistant content here.
		}
	}
	return blocks;
}

function mapUserContent(raw: string | QwenContentBlock[]): UserContentBlock[] {
	if (typeof raw === 'string') {
		return [{ type: 'text', text: raw }];
	}
	const blocks: UserContentBlock[] = [];
	for (const block of raw) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: block.text });
				break;
			case 'tool_result': {
				const inner = block.content;
				let text = '';
				if (typeof inner === 'string') {
					text = inner;
				} else if (Array.isArray(inner)) {
					text = inner
						.map(b => (b.type === 'text' ? b.text : ''))
						.filter(Boolean)
						.join('\n');
				}
				blocks.push({
					type: 'tool_result',
					toolUseId: block.tool_use_id,
					content: text,
					isError: !!block.is_error,
				});
				break;
			}
			// Qwen's content-block type does NOT include image/document on the
			// inbound side — we only emit them on the outbound prompt.
		}
	}
	if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
	return blocks;
}

// ============================================================
// Per-stream state — needed because the Qwen SDK emits
// `content_block_stop` without the block payload, mirroring Anthropic.
// ============================================================

export interface PendingAskUserQuestion {
	questions: AskUserQuestion[];
	answered: boolean;
	answers: Record<string, string> | null;
	/** Last session id we saw the AUQ on — used to stamp the synthetic tool_result. */
	sessionId: string | null;
}

export interface PendingAgent {
	/**
	 * Accumulated text from sub-agent assistant messages whose
	 * `parent_tool_use_id` matches this Agent's call id. Used as the body of
	 * the synthetic tool_result we emit once we can finalize the Agent.
	 */
	accumulatedText: string;
	/** Description from the original `agent` tool input, for status text. */
	description: string;
	/** Last session id we saw the Agent on — used to stamp the synthetic tool_result. */
	sessionId: string | null;
}

export interface QwenConverterState {
	modelId: string;
	/** index → true when the block at that index is a thinking block. */
	reasoningBlocks: Map<number, boolean>;
	/**
	 * Optional callback fired the moment the converter sees a tool_use block
	 * whose canonical name is `AskUserQuestion`. The engine wires this to the
	 * pending-answer slot so `resolveUserAnswer(toolUseId, …)` can verify the
	 * inbound id matches the one the frontend was shown — Qwen's `canUseTool`
	 * callback intentionally does NOT pass the tool_use_id (line 486179 of the
	 * bundled CLI), so the converter is the only place we can recover it.
	 */
	onAskUserQuestionEmitted?: (toolUseId: string) => void;
	/**
	 * Open AskUserQuestion calls keyed by tool_use_id. Populated when the
	 * assistant message containing the AUQ tool_use is converted. The engine
	 * pushes the user's answers in via `recordUserAnswer` as soon as
	 * `resolveUserAnswer` fires; the entry stays around until the SDK emits
	 * the AUQ tool_result, at which point we replace its content.
	 */
	askUserQuestions: Map<string, PendingAskUserQuestion>;
	/**
	 * Open Agent calls keyed by tool_use_id. Qwen's built-in `agent` tool
	 * returns immediately with a placeholder ("Fork started …") regardless of
	 * whether the sub-agent actually finished — we track each Agent here so
	 * we can suppress the placeholder, accumulate the sub-agent's output, and
	 * emit a synthetic completion tool_result later (via `task_notification`
	 * for run_in_background mode, or the SDK's final result event for forks).
	 */
	pendingAgents: Map<string, PendingAgent>;
}

export function createConverterState(modelId: string): QwenConverterState {
	return {
		modelId,
		reasoningBlocks: new Map(),
		askUserQuestions: new Map(),
		pendingAgents: new Map(),
	};
}

// ============================================================
// Top-level dispatchers
// ============================================================

export function convertAssistantMessage(msg: SDKAssistantMessage, state: QwenConverterState): EngineOutput[] {
	const sessionId = msg.session_id;
	const inner = msg.message;
	const content = inner.content;
	const outputs: EngineOutput[] = [];

	const thinkingBlocks = content.filter(b => b.type === 'thinking');
	if (thinkingBlocks.length > 0) {
		const text = thinkingBlocks
			.map(b => (b.type === 'thinking' ? b.thinking : ''))
			.join('\n')
			.trim();
		if (text) {
			const reasoning: ReasoningMessage = {
				type: 'reasoning',
				createdAt: new Date().toISOString(),
				messageId: crypto.randomUUID(),
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
				engine: buildEngine(state.modelId),
				text,
			};
			outputs.push(reasoning);
		}
	}

	const otherBlocks = content.filter(b => b.type !== 'thinking');
	const blocks = mapAssistantContent(
		otherBlocks.length > 0 ? otherBlocks : [{ type: 'text', text: '' } as QwenContentBlock],
		state,
		sessionId,
	);

	// If this assistant message belongs to a sub-agent (parent_tool_use_id
	// matches a tracked Agent), accumulate its text into the parent Agent's
	// buffer so we can use it as the final tool_result content when we
	// finalize the Agent (via task_notification or the SDK's result event).
	const parentToolUseId = msg.parent_tool_use_id || null;
	if (parentToolUseId && state.pendingAgents.has(parentToolUseId)) {
		const entry = state.pendingAgents.get(parentToolUseId)!;
		const subText = blocks
			.filter(b => b.type === 'text')
			.map(b => (b.type === 'text' ? b.text : ''))
			.filter(Boolean)
			.join('\n');
		if (subText) {
			entry.accumulatedText = entry.accumulatedText
				? `${entry.accumulatedText}\n${subText}`
				: subText;
		}
	}

	const baseId = msg.uuid || crypto.randomUUID();
	if (blocks.length <= 1) {
		const assistant: AssistantMessage = {
			type: 'assistant',
			createdAt: new Date().toISOString(),
			messageId: baseId,
			sessionId,
			parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
			engine: buildEngine(state.modelId),
			content: blocks,
			stopReason: mapStopReason(inner.stop_reason),
			usage: mapUsage(inner.usage),
		};
		outputs.push(assistant);
	} else {
		// One tool_use per AssistantMessage (README §10.3).
		blocks.forEach((block, idx) => {
			const assistant: AssistantMessage = {
				type: 'assistant',
				createdAt: new Date().toISOString(),
				messageId: `${baseId}:${idx}`,
				sessionId,
				parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
				engine: buildEngine(state.modelId),
				content: [block],
				stopReason: block.type === 'tool_use' ? 'tool_use' : mapStopReason(inner.stop_reason),
				usage: idx === blocks.length - 1 ? mapUsage(inner.usage) : null,
			};
			outputs.push(assistant);
		});
	}

	return outputs;
}

/**
 * Convert an SDK user message into a unified `UserMessage`, intercepting
 * tool_result blocks for AskUserQuestion and the Agent fork placeholder.
 *
 * Returns `null` when every content block was intercepted/dropped — the
 * dispatcher then emits nothing (we'll synthesize the real result later from
 * `task_notification` or the SDK's final result event).
 */
export function convertUserMessage(msg: SDKUserMessage, state: QwenConverterState): UserMessage | null {
	const rawBlocks = mapUserContent(msg.message.content);
	const outBlocks: UserContentBlock[] = [];

	for (const block of rawBlocks) {
		if (block.type !== 'tool_result') {
			outBlocks.push(block);
			continue;
		}

		// 1. AskUserQuestion: replace the SDK's broken empty-answer body with
		//    the real answers. The Qwen SDK's stream-json `handleOutgoingPermissionRequest`
		//    calls `onConfirm(ProceedOnce)` without a payload, dropping the
		//    `answers` we passed via `updatedInput`. See the analysis in
		//    `qwen/stream.ts::resolveUserAnswer` and `cli.js:486478-486485`.
		const auq = state.askUserQuestions.get(block.toolUseId);
		if (auq) {
			const content = auq.answered && auq.answers
				? formatAskUserQuestionResult(auq.questions, auq.answers)
				: 'User did not provide an answer to the questions.';
			outBlocks.push({
				type: 'tool_result',
				toolUseId: block.toolUseId,
				content,
				isError: false,
			});
			state.askUserQuestions.delete(block.toolUseId);
			continue;
		}

		// 2. Agent fork placeholder: drop entirely. The Agent block stays in
		//    the "pending" state in the UI; the real tool_result is emitted
		//    later from `task_notification` or the SDK's result event.
		if (state.pendingAgents.has(block.toolUseId) && isQwenAgentPlaceholderResult(block.content)) {
			continue;
		}

		outBlocks.push(block);
	}

	if (outBlocks.length === 0) return null;

	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: msg.uuid || crypto.randomUUID(),
		sessionId: msg.session_id,
		// Top-level tool_result UserMessage MUST keep parent.toolUseId = null
		// (README §10.5). Sub-agent messages are an explicit exception.
		parent: { messageId: null, sessionId: null, toolUseId: msg.parent_tool_use_id || null },
		engine: buildEngine(state.modelId),
		sender: { id: '', name: '' },
		content: outBlocks,
		synthetic: true,
	};
}

/**
 * Build a synthetic UserMessage carrying a single tool_result block.
 * Used to finalize Agent calls from `task_notification` or the SDK's final
 * result event when the SDK never sent a real tool_result for the Agent.
 */
function buildSyntheticToolResult(
	state: QwenConverterState,
	toolUseId: string,
	sessionId: string | null,
	result: ToolResult,
): UserMessage {
	return {
		type: 'user',
		createdAt: new Date().toISOString(),
		messageId: crypto.randomUUID(),
		sessionId: sessionId ?? '',
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: buildEngine(state.modelId),
		sender: { id: '', name: '' },
		content: [result],
		synthetic: true,
	};
}

export function convertStreamEvent(msg: SDKPartialAssistantMessage, state: QwenConverterState): EngineOutput[] {
	const sessionId = msg.session_id;
	const event = msg.event;
	const outputs: EngineOutput[] = [];

	// Suppress streaming deltas that belong to a backgrounded sub-agent —
	// they double-emit alongside the eventual non-streaming `assistant`
	// message scoped to the sub-agent (which carries `parent_tool_use_id` and
	// is routed into the parent Agent block's subActivities by the frontend
	// grouper). Without this drop, the deltas leak into the main turn's text
	// bubble. See README §10.15 fix #3.
	if (msg.parent_tool_use_id) return outputs;

	switch (event.type) {
		case 'message_start':
		case 'message_stop': {
			outputs.push({
				type: 'stream_event',
				event: event.type === 'message_start' ? 'start' : 'stop',
				sessionId,
				reasoning: false,
			} as StreamLifecycleEvent);
			break;
		}
		case 'content_block_start': {
			const blockType = event.content_block.type;
			const isReasoning = blockType === 'thinking';
			state.reasoningBlocks.set(event.index, isReasoning);
			if (isReasoning) {
				outputs.push({ type: 'stream_event', event: 'start', sessionId, reasoning: true } as StreamLifecycleEvent);
			} else if (blockType === 'text') {
				outputs.push({ type: 'stream_event', event: 'start', sessionId, reasoning: false } as StreamLifecycleEvent);
			}
			break;
		}
		case 'content_block_delta': {
			const delta = event.delta;
			if (delta.type === 'thinking_delta') {
				outputs.push({
					type: 'stream_event',
					event: 'delta',
					sessionId,
					text: delta.thinking || '',
					reasoning: true,
				} as TextDeltaEvent);
			} else if (delta.type === 'text_delta') {
				outputs.push({
					type: 'stream_event',
					event: 'delta',
					sessionId,
					text: delta.text || '',
					reasoning: false,
				} as TextDeltaEvent);
			}
			// input_json_delta: tool argument streaming — the UI doesn't render
			// partial tool inputs, so we drop these and wait for the final
			// assistant.message that carries the full input object.
			break;
		}
		case 'content_block_stop': {
			const isReasoning = state.reasoningBlocks.get(event.index) === true;
			state.reasoningBlocks.delete(event.index);
			outputs.push({ type: 'stream_event', event: 'stop', sessionId, reasoning: isReasoning } as StreamLifecycleEvent);
			break;
		}
	}

	return outputs;
}

export function convertResultSuccess(msg: SDKResultMessageSuccess): SuccessResultEvent {
	return {
		type: 'result',
		subtype: 'success',
		sessionId: msg.session_id,
		numTurns: msg.num_turns || 0,
		totalCostUsd: 0,
		usage: mapUsageRequired(msg.usage),
		stopReason: null,
	};
}

export function convertResultError(msg: SDKResultMessageError): ErrorResultEvent {
	return {
		type: 'result',
		subtype: msg.subtype === 'error_max_turns' ? 'error_max_turns' : 'error_during_execution',
		sessionId: msg.session_id,
		errors: msg.error?.message ? [msg.error.message] : [],
	};
}

export function convertSystemInit(msg: SDKSystemMessage, state: QwenConverterState): SystemInitEvent {
	return {
		type: 'system_init',
		sessionId: msg.session_id,
		model: msg.model || state.modelId,
		engine: 'qwen',
		tools: msg.tools || [],
		mcpServers: (msg.mcp_servers || []).map(s => ({
			name: s.name || '',
			status: (s.status as 'connected' | 'disconnected' | 'error') || 'disconnected',
		})),
	};
}

/**
 * Handle a `task_notification` system message — emitted by the Qwen SDK when
 * a `run_in_background: true` Agent reaches a terminal status. Source:
 * `node_modules/@qwen-code/sdk/dist/cli/cli.js:485345-485353` and 227829.
 *
 * `data` shape (per `cli.js:485240-485249`):
 *   `{ task_id, tool_use_id, status: 'completed'|'failed'|'cancelled'|'running', usage? }`
 *
 * The full sub-agent text is NOT in `data` — it's only in the SDK-internal
 * `modelText` (XML with `<result>`) which is fed to the model on the next
 * turn but never emitted to us. We use the text we accumulated from the
 * sub-agent's assistant messages (via `parent_tool_use_id` routing) instead.
 *
 * Returns the synthetic tool_result UserMessage to emit, or null when the
 * notification doesn't match a tracked Agent (e.g. `status: 'running'`, or
 * the toolUseId belongs to a different stream).
 */
function convertTaskNotification(msg: SDKSystemMessage, state: QwenConverterState): UserMessage | null {
	const data = (msg.data ?? {}) as { tool_use_id?: string; status?: string; task_id?: string };
	const toolUseId = data.tool_use_id;
	if (!toolUseId) return null;

	const entry = state.pendingAgents.get(toolUseId);
	if (!entry) return null;

	// Only finalize on terminal statuses; "running" is intermediate.
	const status = data.status ?? '';
	if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
		return null;
	}

	const isError = status === 'failed' || status === 'cancelled';
	const body = entry.accumulatedText.trim();
	const fallbackByStatus: Record<string, string> = {
		completed: entry.description
			? `Agent task "${entry.description}" completed.`
			: 'Agent task completed.',
		failed: entry.description
			? `Agent task "${entry.description}" failed.`
			: 'Agent task failed.',
		cancelled: entry.description
			? `Agent task "${entry.description}" was cancelled.`
			: 'Agent task was cancelled.',
	};
	const content = body || fallbackByStatus[status];

	state.pendingAgents.delete(toolUseId);

	return buildSyntheticToolResult(state, toolUseId, entry.sessionId ?? msg.session_id, {
		type: 'tool_result',
		toolUseId,
		content,
		isError,
	});
}

/**
 * Finalize any AskUserQuestion / Agent calls that are still open when the
 * SDK ends the query. Without this, the UI would leave Agent blocks spinning
 * forever (Qwen forks have no completion notification — README §10.15) and
 * AUQ blocks would stay pending if the user closed the dialog without
 * answering.
 */
function* flushPendingOnResult(state: QwenConverterState, sessionId: string): Generator<UserMessage> {
	for (const [toolUseId, entry] of state.askUserQuestions) {
		yield buildSyntheticToolResult(state, toolUseId, entry.sessionId ?? sessionId, {
			type: 'tool_result',
			toolUseId,
			content: 'User did not provide an answer to the questions.',
			isError: false,
		});
	}
	state.askUserQuestions.clear();

	for (const [toolUseId, entry] of state.pendingAgents) {
		const body = entry.accumulatedText.trim();
		const fallback = entry.description
			? `Agent task "${entry.description}" completed.`
			: 'Agent task completed.';
		yield buildSyntheticToolResult(state, toolUseId, entry.sessionId ?? sessionId, {
			type: 'tool_result',
			toolUseId,
			content: body || fallback,
			isError: false,
		});
	}
	state.pendingAgents.clear();
}

// ============================================================
// Top-level dispatcher
// ============================================================

export interface SdkMessageConverterOptions {
	/** Forwarded to converter state — see `QwenConverterState.onAskUserQuestionEmitted`. */
	onAskUserQuestionEmitted?: (toolUseId: string) => void;
}

export interface SdkMessageConverter {
	convert(msg: SDKMessage): Generator<EngineOutput>;
	/**
	 * Push the user's answers into the converter state so the next AUQ
	 * tool_result we see can be rewritten with the proper `User has answered
	 * your questions: …` payload. Idempotent — if no AUQ matches the toolUseId,
	 * the call is a no-op (harmless if the SDK already auto-completed it).
	 */
	recordUserAnswer(toolUseId: string, answers: Record<string, string>): void;
}

export function createSdkMessageConverter(
	modelId: string,
	options: SdkMessageConverterOptions = {},
): SdkMessageConverter {
	const state = createConverterState(modelId);
	state.onAskUserQuestionEmitted = options.onAskUserQuestionEmitted;

	function* convert(msg: SDKMessage): Generator<EngineOutput> {
		switch (msg.type) {
			case 'assistant':
				for (const out of convertAssistantMessage(msg, state)) yield out;
				return;
			case 'user': {
				const userMsg = convertUserMessage(msg, state);
				if (userMsg) yield userMsg;
				return;
			}
			case 'stream_event':
				for (const out of convertStreamEvent(msg, state)) yield out;
				return;
			case 'system': {
				if (msg.subtype === 'init') {
					yield convertSystemInit(msg, state);
				} else if (msg.subtype === 'task_notification') {
					const synth = convertTaskNotification(msg, state);
					if (synth) yield synth;
				}
				return;
			}
			case 'result': {
				const result = msg as SDKResultMessage;
				// Flush any still-open AUQ / Agent calls BEFORE the result event
				// so the UI sees their tool_result land in the right order
				// (tool_use → tool_result → result).
				yield* flushPendingOnResult(state, result.session_id);
				if (result.subtype === 'success') {
					yield convertResultSuccess(result);
				} else {
					yield convertResultError(result);
				}
				return;
			}
		}
	}

	return {
		convert,
		recordUserAnswer(toolUseId, answers) {
			const entry = state.askUserQuestions.get(toolUseId);
			if (!entry) return;
			entry.answers = answers;
			entry.answered = true;
		},
	};
}

// ============================================================
// Outbound prompt converter
// ============================================================

export function toSdkUserMessage(msg: UserMessage): SDKUserMessage {
	const sdkContent: QwenContentBlock[] = [];

	for (const block of msg.content) {
		switch (block.type) {
			case 'text':
				sdkContent.push({ type: 'text', text: block.text });
				break;
			case 'tool_result':
				sdkContent.push({
					type: 'tool_result',
					tool_use_id: block.toolUseId,
					content: block.content,
					is_error: block.isError,
				});
				break;
			// Qwen's SDK content-block type does not include image/document
			// blocks for inbound user messages — image/PDF attachments are
			// dropped here. The CLI accepts text-only prompts.
			case 'image':
			case 'document':
				break;
		}
	}

	const content: string | QwenContentBlock[] =
		sdkContent.length === 1 && sdkContent[0].type === 'text'
			? sdkContent[0].text
			: sdkContent;

	return {
		type: 'user',
		uuid: msg.messageId,
		session_id: msg.sessionId ?? '',
		parent_tool_use_id: msg.parent.toolUseId,
		message: { role: 'user', content },
	};
}
