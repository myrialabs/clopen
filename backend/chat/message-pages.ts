/**
 * Reading a chat's active branch a page at a time.
 *
 * Opening a chat used to send its whole branch — every message since the first,
 * images included — which on a long chat was tens of megabytes on every open.
 * The chat now loads its most recent turns and fetches older ones as the user
 * scrolls up (or jumps to a message that is not loaded yet).
 *
 * A page never starts where it would split something the chat renders as one:
 * every tool result and every sub-agent message in it has its tool call in the
 * same page, and it does not begin with a synthetic user message (a compaction
 * summary or an expanded skill prompt, which belong to the message before
 * them). That is checked on the page itself, so a boundary can fall inside a
 * long agent turn — turns of several hundred messages are common, and cutting
 * only at user prompts made the first page nearly the whole chat. A user
 * prompt always qualifies.
 *
 * Two things the chat needs from the WHOLE branch are served separately and
 * cheaply, without message bodies the user is not looking at:
 *  - the prompt index (the navigation rail's dots, one per user prompt);
 *  - the task tools older than the loaded page (the task progress widget
 *    replays TaskCreate / TaskUpdate / TodoWrite from the start).
 */

import { getDatabase } from '../database';
import type { DatabaseMessage } from '$shared/types/database/schema';
import type { UnifiedMessage } from '$shared/types/unified';
import { trimSubAgentForWire } from '$shared/utils/subagent-wire-trim';
import { isCheckpointMessage, extractMessageText } from '../snapshot/helpers';

/**
 * Walks a branch from newest to oldest and says where a page may begin: at a
 * message no later message depends on from across the boundary.
 */
class BoundaryTracker {
	private readonly defined = new Set<string>();
	private readonly needed = new Set<string>();

	/** Record `message` (older than everything seen so far); true if a page may start at it. */
	add(message: UnifiedMessage): boolean {
		if (message.type === 'user' || message.type === 'assistant') {
			const parentToolUseId = message.parent?.toolUseId;
			if (parentToolUseId && !this.defined.has(parentToolUseId)) this.needed.add(parentToolUseId);
			for (const block of message.content) {
				if (block.type === 'tool_result') {
					const id = (block as { toolUseId?: string }).toolUseId;
					if (id && !this.defined.has(id)) this.needed.add(id);
				} else if (block.type === 'tool_use') {
					this.defined.add(block.id);
					this.needed.delete(block.id);
				}
			}
		}
		const synthetic = message.type === 'user' && (message as { synthetic?: boolean }).synthetic === true;
		return this.needed.size === 0 && !synthetic;
	}
}

/** Messages a page holds at least — then it is extended back to the start of a turn. */
export const DEFAULT_PAGE_SIZE = 80;

/** Longest prompt preview the navigation rail shows. */
const PROMPT_PREVIEW_LENGTH = 200;

/** Tools the task progress widget replays. */
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TodoWrite'] as const;

export interface MessagePage {
	/** Oldest first, as the chat renders them. */
	messages: UnifiedMessage[];
	/** Whether older messages exist on the branch before this page. */
	hasMore: boolean;
}

export interface PromptIndexEntry {
	messageId: string;
	text: string;
	createdAt: string;
}

function headOf(sessionId: string): string | null {
	const row = getDatabase()
		.prepare('SELECT head_message_id FROM chat_sessions WHERE id = ?')
		.get(sessionId) as { head_message_id: string | null } | null;
	return row?.head_message_id ?? null;
}

/**
 * One page of the active branch, ending just before `beforeId` (or at the head
 * when absent). Holds at least `minCount` messages and always begins at a turn.
 */
export function getMessagePage(
	sessionId: string,
	options: { beforeId?: string; minCount?: number } = {}
): MessagePage {
	const minCount = Math.max(1, options.minCount ?? DEFAULT_PAGE_SIZE);
	const byId = getDatabase().prepare('SELECT * FROM messages WHERE id = ? AND session_id = ?');

	let cursor: string | null;
	if (options.beforeId) {
		const anchor = byId.get(options.beforeId, sessionId) as DatabaseMessage | null;
		if (!anchor) return { messages: [], hasMore: false };
		cursor = anchor.parent_message_id ?? null;
	} else {
		cursor = headOf(sessionId);
	}

	const messages: UnifiedMessage[] = [];
	const boundary = new BoundaryTracker();
	while (cursor) {
		const row = byId.get(cursor, sessionId) as DatabaseMessage | null;
		if (!row) {
			cursor = null;
			break;
		}
		const message = JSON.parse(row.data) as UnifiedMessage;
		messages.push(message);
		cursor = row.parent_message_id ?? null;
		const mayStartHere = boundary.add(message);
		if (messages.length >= minCount && mayStartHere) break;
	}

	return {
		messages: messages.reverse().map(trimSubAgentForWire),
		hasMore: cursor !== null && byId.get(cursor, sessionId) != null
	};
}

/**
 * The branch, newest first, as light rows: id and parent for every message,
 * plus the body only where `wantBody` says so (decided in SQL, so the bodies
 * of everything else — tool output, images — are never read into JS).
 */
function branchRows(
	sessionId: string,
	wantBody: string,
	fromId: string | null
): Array<{ id: string; parent_message_id: string | null; data: string | null }> {
	if (!fromId) return [];
	const rows = getDatabase()
		.prepare(`SELECT id, parent_message_id, CASE WHEN ${wantBody} THEN data END AS data FROM messages WHERE session_id = ?`)
		.all(sessionId) as Array<{ id: string; parent_message_id: string | null; data: string | null }>;
	const byId = new Map(rows.map((row) => [row.id, row]));

	const branch: typeof rows = [];
	const seen = new Set<string>();
	let cursor: string | null = fromId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const row = byId.get(cursor);
		if (!row) break;
		branch.push(row);
		cursor = row.parent_message_id;
	}
	return branch;
}

/** Every user prompt on the active branch, oldest first — the navigation rail. */
export function getPromptIndex(sessionId: string): PromptIndexEntry[] {
	const rows = branchRows(sessionId, `json_extract(data, '$.type') = 'user'`, headOf(sessionId));
	const prompts: PromptIndexEntry[] = [];
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (!row.data) continue;
		const asRow = row as unknown as DatabaseMessage;
		if (!isCheckpointMessage(asRow)) continue;
		const message = JSON.parse(row.data) as UnifiedMessage;
		prompts.push({
			messageId: row.id,
			text: extractMessageText(message).slice(0, PROMPT_PREVIEW_LENGTH),
			createdAt: (message as { createdAt?: string }).createdAt ?? ''
		});
	}
	return prompts;
}

/**
 * The task-tool calls (and their results) on the branch older than `beforeId`,
 * oldest first. Together with the loaded messages this is exactly what the task
 * widget used to replay from the full branch.
 */
export function getTaskHistory(sessionId: string, beforeId: string): UnifiedMessage[] {
	const parent = getDatabase()
		.prepare('SELECT parent_message_id FROM messages WHERE id = ? AND session_id = ?')
		.get(beforeId, sessionId) as { parent_message_id: string | null } | null;
	if (!parent?.parent_message_id) return [];

	// Pass 1: the branch, with bodies only for messages that call a task tool.
	const mentionsTaskTool = TASK_TOOLS.map((name) => `instr(data, '"name":"${name}"') > 0`).join(' OR ');
	const branch = branchRows(sessionId, mentionsTaskTool, parent.parent_message_id).reverse();

	const taskCallIds = new Set<string>();
	const calls = new Map<string, UnifiedMessage>();
	for (const row of branch) {
		if (!row.data) continue;
		const message = JSON.parse(row.data) as UnifiedMessage;
		if (message.type !== 'assistant') continue;
		let hasTaskCall = false;
		for (const block of message.content) {
			if (block.type === 'tool_use' && (TASK_TOOLS as readonly string[]).includes(block.name)) {
				taskCallIds.add(block.id);
				hasTaskCall = true;
			}
		}
		if (hasTaskCall) calls.set(row.id, message);
	}
	if (taskCallIds.size === 0) return [];

	// Pass 2: only the messages that answer one of those calls — never the
	// thousands of other tool results (file reads, screenshots) on the branch.
	const ids = [...taskCallIds];
	const answerRows = getDatabase()
		.prepare(
			`SELECT id, data FROM messages WHERE session_id = ? AND (${ids.map(() => 'instr(data, ?) > 0').join(' OR ')})`
		)
		.all(sessionId, ...ids.map((id) => `"toolUseId":"${id}"`)) as Array<{ id: string; data: string }>;
	const answers = new Map<string, UnifiedMessage>();
	for (const row of answerRows) {
		const message = JSON.parse(row.data) as UnifiedMessage;
		if (message.type !== 'user') continue;
		const answersTask = message.content.some(
			(block) => block.type === 'tool_result' && taskCallIds.has((block as { toolUseId: string }).toolUseId)
		);
		if (answersTask) answers.set(row.id, message);
	}

	const history: UnifiedMessage[] = [];
	for (const row of branch) {
		const message = calls.get(row.id) ?? answers.get(row.id);
		if (message) history.push(message);
	}
	return history;
}
