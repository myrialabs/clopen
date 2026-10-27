/**
 * The answer a turn ended with — what a chat app shows as "the reply".
 *
 * A turn is a user message followed by assistant messages, tool calls and tool
 * results; what reads as the answer is the text of the LAST assistant message
 * that has any (the earlier ones are the "let me look at…" between tools).
 * `head_summary` is not this: it is cut to 200 characters with code removed,
 * fit for a session list, not for a conversation.
 *
 * Walks back from HEAD only as far as the turn's own user message, one row at
 * a time, so a long session is not loaded whole to read its last reply.
 */

import { messageQueries, sessionQueries } from '$backend/database/queries';
import { isInternalToolMessage } from '$backend/snapshot/helpers';
import type { UnifiedMessage } from '$shared/types/unified';

/** A turn is never this long; the bound only protects against a corrupt parent chain. */
const MAX_WALK = 2000;

export interface TurnAnswer {
	/** The answer's Markdown, or '' when the turn produced no text. */
	text: string;
	/** The error the turn ended with, when it failed — never part of `text`. */
	error: string | null;
	/** HEAD when read — the message a reply to this answer continues from. */
	endMessageId: string | null;
	/** The turn's own user message. */
	userMessageId: string | null;
}

/**
 * Where a turn starts: any message the user sent — including one that is only
 * a photo, which a snapshot checkpoint (text required) would not count.
 */
function isTurnStart(row: { data: string }): boolean {
	try {
		const message = JSON.parse(row.data) as UnifiedMessage;
		return message.type === 'user' && !isInternalToolMessage(message);
	} catch {
		return false;
	}
}

/** The stream records a failure as an assistant message with this prefix. */
const ERROR_PREFIX = '**Error:** ';

function textOf(message: UnifiedMessage): string {
	if (message.type !== 'assistant' || !Array.isArray(message.content)) return '';
	return message.content
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => (block as { text: string }).text)
		.join('\n\n')
		.trim();
}

export function lastTurnAnswer(chatSessionId: string): TurnAnswer {
	const head = sessionQueries.getHead(chatSessionId);
	if (!head) return { text: '', error: null, endMessageId: null, userMessageId: null };

	let error: string | null = null;
	let currentId: string | null = head;
	for (let steps = 0; currentId && steps < MAX_WALK; steps++) {
		const row = messageQueries.getById(currentId);
		if (!row) break;
		if (isTurnStart(row)) return { text: '', error, endMessageId: head, userMessageId: row.id };
		try {
			const message = JSON.parse(row.data) as UnifiedMessage;
			// Sub-agent output carries the tool call it answers; it is not the reply.
			const isSubAgent = message.type === 'assistant' && message.parent?.toolUseId != null;
			const text = isSubAgent ? '' : textOf(message);
			// The failure the turn ended with is reported apart; what the turn said
			// before it is still the answer so far.
			if (text.startsWith(ERROR_PREFIX) && error === null && steps === 0) {
				error = text.slice(ERROR_PREFIX.length).trim();
			} else if (text) {
				return { text, error, endMessageId: head, userMessageId: findTurnStart(row.parent_message_id ?? null) };
			}
		} catch {
			// Unparseable row — skip it like any message without text.
		}
		currentId = row.parent_message_id ?? null;
	}
	return { text: '', error, endMessageId: head, userMessageId: null };
}

function findTurnStart(fromId: string | null): string | null {
	let currentId = fromId;
	for (let steps = 0; currentId && steps < MAX_WALK; steps++) {
		const row = messageQueries.getById(currentId);
		if (!row) return null;
		if (isTurnStart(row)) return row.id;
		currentId = row.parent_message_id ?? null;
	}
	return null;
}

/** The text of a user message as the user wrote it — what /retry and an edit resend. */
export function userMessageText(messageId: string): string | null {
	const row = messageQueries.getById(messageId);
	if (!row) return null;
	try {
		const message = JSON.parse(row.data) as UnifiedMessage;
		if (message.type !== 'user' || !Array.isArray(message.content)) return null;
		return message.content
			.filter((block) => block.type === 'text' && typeof (block as { text?: string }).text === 'string')
			.map((block) => (block as { text: string }).text)
			.join('\n')
			.trim() || null;
	} catch {
		return null;
	}
}

/** Cut Markdown at a paragraph boundary near `max`, so a quoted excerpt never ends mid-fence. */
export function excerptMarkdown(markdown: string, max: number): string {
	const trimmed = markdown.trim();
	if (trimmed.length <= max) return trimmed;
	const window = trimmed.slice(0, max);
	const cut = window.lastIndexOf('\n\n');
	let excerpt = cut > max / 2 ? window.slice(0, cut) : window;
	// An odd number of fences means the cut landed inside a code block — close it.
	if ((excerpt.match(/^\s*```/gm) ?? []).length % 2 === 1) excerpt += '\n```';
	return `${excerpt.trimEnd()}\n\n…`;
}
