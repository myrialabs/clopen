/**
 * Cross-engine conversation handoff.
 *
 * Every engine keeps continuity in its own native session store — a Claude
 * session id, a Codex rollout file, an OpenCode server session, Cline's
 * in-memory transcript. Those ids are not portable, so a session that switches
 * engine mid-conversation has nothing for the new engine to resume from. This
 * module rebuilds the branch from Clopen's own DB and hands it to the new
 * engine as prompt content, so the user can change engine without starting a
 * new chat.
 *
 * ── The rule ──
 * Replay the branch verbatim. When the replay exceeds the trigger threshold,
 * tool results older than the last N tool uses are replaced with a placeholder
 * — tool *inputs* are always kept.
 *
 * Both numbers are the shipped defaults of Anthropic's `clear_tool_uses_20250919`
 * context-editing strategy (trigger 100k input tokens, keep 3 tool uses,
 * `clear_tool_inputs: false`). We mirror them rather than inventing our own
 * because they are measured: context editing alone reports +29% on agentic
 * benchmarks, and an 84% token reduction on long tool-heavy runs while
 * completing tasks that otherwise fail. See
 * https://platform.claude.com/docs/en/build-with-claude/context-editing.
 *
 * Deliberately NOT keyed on `compact_boundary`: only the Claude adapter ever
 * emits one (OpenCode drops compaction events, Pi disables compaction outright),
 * so a boundary-based window would silently degenerate to "replay everything"
 * on 7 of 8 engines.
 *
 * The handoff never touches the timeline: it is prepended to the *engine*
 * prompt only, never to the `UserMessage` that gets persisted and rendered.
 */

import { messageQueries, sessionQueries } from '../database/queries';
import { getModelsByEngine } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import type {
	EngineType,
	UnifiedMessage,
	UserMessage,
	AssistantMessage,
	ReasoningMessage,
	UserContentBlock,
	ImageBlock,
	DocumentBlock,
} from '$shared/types/unified';

// ============================================================================
// Tunables — ported from clear_tool_uses_20250919 defaults
// ============================================================================

/** Replay stays fully verbatim below this estimated input-token count. */
const TRIGGER_TOKENS = 100_000;

/** Tool uses whose results survive clearing, counted from the end. */
const KEEP_TOOL_USES = 3;

/** Rough token estimate. Good enough to decide whether clearing is needed. */
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Intermediate representation
// ============================================================================

type Entry =
	| { kind: 'user'; text: string; attachments: Array<ImageBlock | DocumentBlock> }
	| { kind: 'assistant'; text: string }
	| { kind: 'reasoning'; text: string }
	| { kind: 'tool_use'; id: string; name: string; input: unknown }
	| { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
	| { kind: 'compact' };

export interface HandoffStats {
	turns: number;
	clearedToolResults: number;
	droppedAttachments: number;
	estimatedTokens: number;
}

export interface HandoffResult {
	/** Blocks to prepend to the engine prompt. Never empty when non-null. */
	blocks: UserContentBlock[];
	stats: HandoffStats;
}

// ============================================================================
// Branch inspection
// ============================================================================

function parse(data: string): UnifiedMessage | null {
	try {
		return JSON.parse(data) as UnifiedMessage;
	} catch {
		return null;
	}
}

/**
 * The engine that produced the trailing part of this branch, i.e. the engine
 * whose native session a resume would target.
 *
 * Walks back to the most recent NON-user message and reads its `engine.type`.
 * User messages carry the *sending* client's engine choice, which is exactly
 * what we must not trust here. Falls back to `chat_sessions.engine` for legacy
 * rows written before messages carried an engine block — that column is
 * reliable because `chat:model-sync` persists it the moment anyone picks an
 * engine, not only on send.
 */
export function resolveBranchEngine(chatSessionId: string): EngineType | null {
	try {
		const head = sessionQueries.getHead(chatSessionId);
		if (head) {
			const chain = messageQueries.getPathToRoot(head);
			for (let i = chain.length - 1; i >= 0; i--) {
				const msg = parse(chain[i].data);
				if (!msg || msg.type === 'user') continue;
				const type = msg.engine?.type;
				if (type) return type as EngineType;
			}
		}
	} catch (error) {
		debug.error('chat', 'Failed to resolve branch engine:', error);
	}

	try {
		const session = sessionQueries.getById(chatSessionId);
		return (session?.engine as EngineType) || null;
	} catch {
		return null;
	}
}

// ============================================================================
// Attachment capability
// ============================================================================

/**
 * Whether the target can actually carry an attachment kind.
 *
 * Two independent gates. The model catalog says what the MODEL accepts; this
 * table says what the ADAPTER actually forwards. They genuinely differ —
 * Codex, Cursor, Pi and Cline have no document path at all, so a PDF handed to
 * them vanishes no matter what the catalog claims. Trusting the catalog alone
 * would silently vaporise history.
 */
function attachmentSupport(engine: EngineType, modelId: string): { image: boolean; document: boolean } {
	const ADAPTER_IMAGE: Record<EngineType, boolean> = {
		'claude-code': true,
		opencode: true,
		codex: true,
		cursor: true,
		pi: true,
		cline: true,
		qwen: true,
		copilot: true,
	};
	const ADAPTER_DOCUMENT: Record<EngineType, boolean> = {
		'claude-code': true,
		opencode: true,
		qwen: true,
		copilot: true,
		codex: false,
		cursor: false,
		pi: false,
		cline: false,
	};

	const model = getModelsByEngine(engine).find(m => m.engine.model.id === modelId);
	// Unknown model (catalog not yet populated in this process): trust the
	// adapter gate alone rather than stripping attachments that would work.
	const modelImage = model ? model.modalities.input.image : true;
	const modelDocument = model ? model.modalities.input.pdf : true;

	return {
		image: ADAPTER_IMAGE[engine] && modelImage,
		document: ADAPTER_DOCUMENT[engine] && modelDocument,
	};
}

// ============================================================================
// Collection
// ============================================================================

function collect(messages: UnifiedMessage[]): Entry[] {
	const entries: Entry[] = [];

	for (const msg of messages) {
		// Sub-agent traffic never reaches the root timeline and is already
		// summarised by its parent tool result — replaying it would duplicate
		// the same work in a far more verbose form.
		if (msg.parent?.toolUseId) continue;

		switch (msg.type) {
			case 'user': {
				const user = msg as UserMessage;
				const texts: string[] = [];
				const attachments: Array<ImageBlock | DocumentBlock> = [];
				let emittedResult = false;

				for (const block of user.content) {
					if (block.type === 'text') {
						if (block.text.trim()) texts.push(block.text);
					} else if (block.type === 'image' || block.type === 'document') {
						attachments.push(block);
					} else if (block.type === 'tool_result') {
						entries.push({
							kind: 'tool_result',
							toolUseId: block.toolUseId,
							content: block.content,
							isError: block.isError,
						});
						emittedResult = true;
					}
				}

				// A tool-result carrier is not a conversational turn; the result
				// entries above already represent it.
				if (emittedResult) break;
				// Synthetic post-compaction summaries ARE worth replaying: they are
				// the engine's own compression of everything before them.
				if (texts.length || attachments.length) {
					entries.push({ kind: 'user', text: texts.join('\n'), attachments });
				}
				break;
			}

			case 'assistant': {
				const assistant = msg as AssistantMessage;
				for (const block of assistant.content) {
					if (block.type === 'text') {
						if (block.text.trim()) entries.push({ kind: 'assistant', text: block.text });
					} else if (block.type === 'tool_use') {
						entries.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
					}
				}
				break;
			}

			case 'reasoning': {
				const reasoning = msg as ReasoningMessage;
				if (reasoning.text.trim()) entries.push({ kind: 'reasoning', text: reasoning.text });
				break;
			}

			case 'compact_boundary':
				entries.push({ kind: 'compact' });
				break;
		}
	}

	return entries;
}

// ============================================================================
// Rendering
// ============================================================================

function stringifyInput(input: unknown): string {
	try {
		const json = JSON.stringify(input);
		return json ?? String(input);
	} catch {
		return '[uninspectable input]';
	}
}

function renderEntries(entries: Entry[], clearedToolUseIds: Set<string>, support: { image: boolean; document: boolean }): {
	lines: string[];
	attachments: Array<ImageBlock | DocumentBlock>;
	droppedAttachments: number;
} {
	const lines: string[] = [];
	const attachments: Array<ImageBlock | DocumentBlock> = [];
	let droppedAttachments = 0;

	for (const entry of entries) {
		switch (entry.kind) {
			case 'user': {
				if (entry.text) lines.push(`[user]\n${entry.text}`);
				for (const att of entry.attachments) {
					const supported = att.type === 'image' ? support.image : support.document;
					if (supported) {
						attachments.push(att);
						lines.push(`[user attachment: ${describeAttachment(att)}]`);
					} else {
						droppedAttachments++;
						lines.push(`[user attachment: ${describeAttachment(att)} — not supported by this model, content omitted]`);
					}
				}
				break;
			}
			case 'assistant':
				lines.push(`[assistant]\n${entry.text}`);
				break;
			case 'reasoning':
				lines.push(`[assistant thinking]\n${entry.text}`);
				break;
			case 'tool_use':
				lines.push(`[tool call: ${entry.name}]\n${stringifyInput(entry.input)}`);
				break;
			case 'tool_result':
				if (clearedToolUseIds.has(entry.toolUseId)) {
					lines.push('[tool result cleared to save context — re-run the tool if you need it]');
				} else {
					lines.push(`[tool result${entry.isError ? ' (error)' : ''}]\n${entry.content}`);
				}
				break;
			case 'compact':
				// The boundary marker comes first, then the engine's own summary as
				// a synthetic user message — that ordering is what message-grouper
				// relies on, so the wording here must match it.
				lines.push('[the previous engine compacted the conversation here; the summary that follows replaced everything above it]');
				break;
		}
	}

	return { lines, attachments, droppedAttachments };
}

function describeAttachment(att: ImageBlock | DocumentBlock): string {
	if (att.type === 'document') return att.title ? `${att.title} (${att.mediaType})` : att.mediaType;
	return att.mediaType;
}

function estimateTokens(lines: string[]): number {
	let chars = 0;
	for (const line of lines) chars += line.length + 1;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a branch (already parsed, root → head order) into handoff blocks.
 *
 * Pure: no DB, no registry. `buildEngineHandoff` is the thin DB-reading wrapper
 * around it, which is also what makes the interesting behaviour — clearing,
 * attachment gating, sub-agent filtering — directly testable.
 */
export function renderHandoff(
	messages: UnifiedMessage[],
	support: { image: boolean; document: boolean },
	previousEngine: EngineType | null
): HandoffResult | null {
	const entries = collect(messages);
	if (!entries.length) return null;

	// First pass: verbatim. Only if that exceeds the trigger do we clear, and
	// then only the tool results outside the most recent KEEP_TOOL_USES.
	const clearedToolUseIds = new Set<string>();
	let render = renderEntries(entries, clearedToolUseIds, support);

	if (estimateTokens(render.lines) > TRIGGER_TOKENS) {
		const toolUseIds = entries.filter((e): e is Extract<Entry, { kind: 'tool_use' }> => e.kind === 'tool_use').map(e => e.id);
		const kept = new Set(toolUseIds.slice(-KEEP_TOOL_USES));
		for (const id of toolUseIds) {
			if (!kept.has(id)) clearedToolUseIds.add(id);
		}
		render = renderEntries(entries, clearedToolUseIds, support);
	}

	const turns = entries.filter(e => e.kind === 'user' || e.kind === 'assistant').length;
	const estimatedTokens = estimateTokens(render.lines);

	const header = previousEngine
		? `The conversation below happened in this same chat, driven by a different engine (${previousEngine}). You are taking over from it.`
		: 'The conversation below happened earlier in this same chat. You are taking over from it.';

	const transcript = [
		header,
		'Treat it as your own prior context: it is what you already said, did and learned. Do not greet the user as if this were a new conversation, and do not repeat work that is already done. Anything marked as cleared or omitted can be re-derived with your tools.',
		'',
		'<conversation-transcript>',
		...render.lines,
		'</conversation-transcript>',
		'',
		'The user\'s new message follows.',
	].join('\n');

	const blocks: UserContentBlock[] = [{ type: 'text', text: transcript }, ...render.attachments];

	return {
		blocks,
		stats: {
			turns,
			clearedToolResults: clearedToolUseIds.size,
			droppedAttachments: render.droppedAttachments,
			estimatedTokens,
		},
	};
}

/**
 * Build the handoff blocks for a branch, or null when there is nothing to hand
 * over (empty session, unreadable chain).
 *
 * `targetEngine` / `targetModelId` describe the engine the user just switched
 * TO — they decide which attachments can ride along.
 *
 * `excludeMessageId` is the turn's own user message. By the time this runs it
 * has already been saved and IS the branch head, so without excluding it the
 * transcript would end with a verbatim copy of the message the engine is about
 * to be asked to answer.
 */
export function buildEngineHandoff(
	chatSessionId: string,
	targetEngine: EngineType,
	targetModelId: string,
	previousEngine: EngineType | null,
	excludeMessageId?: string
): HandoffResult | null {
	let messages: UnifiedMessage[];
	try {
		const head = sessionQueries.getHead(chatSessionId);
		if (!head) return null;
		messages = messageQueries
			.getPathToRoot(head)
			.filter(row => row.id !== excludeMessageId)
			.map(row => parse(row.data))
			.filter((msg): msg is UnifiedMessage => msg !== null);
	} catch (error) {
		debug.error('chat', 'Engine handoff: failed to read branch:', error);
		return null;
	}
	if (!messages.length) return null;

	return renderHandoff(messages, attachmentSupport(targetEngine, targetModelId), previousEngine);
}

/**
 * Prepend handoff blocks to a prompt, returning a new UserMessage. The original
 * message is left untouched so the persisted/rendered timeline never sees the
 * transcript.
 */
export function withHandoff(prompt: UserMessage, blocks: UserContentBlock[]): UserMessage {
	return { ...prompt, content: [...blocks, ...prompt.content] };
}
