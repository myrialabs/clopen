/**
 * Chat-app storage — which chat is paired through which bot,
 * what each chat is currently talking to, and what every message in the chat
 * app means in Clopen. See migration 084 for why each table exists.
 */

import { randomBytes } from 'crypto';
import { getDatabase } from '../index';

export interface ChannelLinkRow {
	id: string;
	account_id: string;
	user_id: string;
	conversation_id: string;
	platform_user_id: string;
	display_name: string | null;
	/** 0 turns the chat off entirely: it can neither be told nor tell Clopen anything. */
	is_enabled: number;
	active_project_id: string | null;
	active_session_id: string | null;
	created_at: string;
	last_used_at: string | null;
}

/**
 * What a message in the chat app stands for.
 *
 *   question  an AskUserQuestion still (or no longer) waiting on a tap
 *   finished  a "run finished / failed" notification for a turn
 *   answer    the assistant's reply to a turn, sent to the chat
 *   user      the user's own prompt, as they typed it in the chat app
 *   menu      a list of projects / sessions / models offered as buttons
 *   confirm   "this will restore files — go ahead?"
 */
export type ChannelMessageKind = 'question' | 'answer' | 'user' | 'menu' | 'confirm';
export type ChannelMessageState = 'open' | 'answered' | 'closed';

export interface ChannelMessageRow {
	id: string;
	link_id: string;
	kind: ChannelMessageKind;
	project_id: string | null;
	chat_session_id: string | null;
	tool_use_id: string | null;
	question_index: number | null;
	/** The Clopen message this row stands for: a user message, or the end of a turn. */
	clopen_message_id: string | null;
	platform_message_id: string;
	state: ChannelMessageState;
	payload: string;
	created_at: string;
}

export interface ChannelMessageInput {
	/** Pre-minted when the id has to ride inside the message's own buttons. */
	id?: string;
	linkId: string;
	kind: ChannelMessageKind;
	projectId?: string | null;
	chatSessionId?: string | null;
	toolUseId?: string | null;
	questionIndex?: number | null;
	clopenMessageId?: string | null;
	platformMessageId: string;
	state?: ChannelMessageState;
	payload?: unknown;
}

/**
 * Row ids travel inside a button. Ten base62 characters is ~59 bits — far
 * past guessable, and short enough to leave room in a 64-byte button for the
 * action that rides along with it.
 */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newChannelMessageId(): string {
	const bytes = randomBytes(10);
	let id = '';
	for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
	return id;
}

export const channelLinkQueries = {
	/** Switched on: the only state in which a chat can do anything. */
	isActive(row: ChannelLinkRow): boolean {
		return row.is_enabled === 1;
	},

	getById(id: string): ChannelLinkRow | null {
		return (getDatabase().prepare('SELECT * FROM channel_links WHERE id = ?').get(id) as ChannelLinkRow | null) ?? null;
	},

	getByConversation(accountId: string, conversationId: string): ChannelLinkRow | null {
		return (getDatabase()
			.prepare('SELECT * FROM channel_links WHERE account_id = ? AND conversation_id = ?')
			.get(accountId, conversationId) as ChannelLinkRow | null) ?? null;
	},

	listByAccount(accountId: string): ChannelLinkRow[] {
		return getDatabase()
			.prepare('SELECT * FROM channel_links WHERE account_id = ? ORDER BY created_at')
			.all(accountId) as ChannelLinkRow[];
	},

	/**
	 * Pair a chat. Re-pairing the same chat moves it rather than failing:
	 * whoever just proved they hold the chat AND a fresh code from a Clopen
	 * session holds it now, and nothing the previous holder was talking to
	 * carries over.
	 */
	upsert(input: {
		accountId: string;
		userId: string;
		conversationId: string;
		platformUserId: string;
		displayName: string | null;
	}): ChannelLinkRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		const existing = this.getByConversation(input.accountId, input.conversationId);
		if (existing) {
			const changedHands = existing.platform_user_id !== input.platformUserId;
			db.prepare(
				`UPDATE channel_links
				 SET user_id = ?, platform_user_id = ?, display_name = ?, is_enabled = 1, last_used_at = ?
				 WHERE id = ?`
			).run(input.userId, input.platformUserId, input.displayName, now, existing.id);
			if (changedHands) {
				// A chat that changed hands must not keep answering — or continuing — the old holder's sessions.
				db.prepare("UPDATE channel_messages SET state = 'closed' WHERE link_id = ? AND state = 'open'").run(existing.id);
				db.prepare('UPDATE channel_links SET active_project_id = NULL, active_session_id = NULL WHERE id = ?').run(existing.id);
			}
			return this.getById(existing.id)!;
		}
		const id = crypto.randomUUID();
		db.prepare(
			`INSERT INTO channel_links
			 (id, account_id, user_id, conversation_id, platform_user_id, display_name, created_at, last_used_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(id, input.accountId, input.userId, input.conversationId, input.platformUserId, input.displayName, now, now);
		return this.getById(id)!;
	},

	setEnabled(id: string, enabled: boolean): void {
		getDatabase().prepare('UPDATE channel_links SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
	},

	/** What a plain message from this chat continues. A null session means "start one in this project". */
	setActive(id: string, projectId: string | null, sessionId: string | null): void {
		getDatabase()
			.prepare('UPDATE channel_links SET active_project_id = ?, active_session_id = ? WHERE id = ?')
			.run(projectId, sessionId, id);
	},

	/** Forget a session that no longer exists, everywhere it was the active one. */
	clearActiveSession(sessionId: string): void {
		getDatabase().prepare('UPDATE channel_links SET active_session_id = NULL WHERE active_session_id = ?').run(sessionId);
	},

	touch(id: string): void {
		getDatabase().prepare('UPDATE channel_links SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
	},

	remove(id: string): void {
		getDatabase().prepare('DELETE FROM channel_links WHERE id = ?').run(id);
	}
};

export const channelMessageQueries = {
	create(input: ChannelMessageInput): ChannelMessageRow {
		const id = input.id ?? newChannelMessageId();
		getDatabase()
			.prepare(
				`INSERT INTO channel_messages
				 (id, link_id, kind, project_id, chat_session_id, tool_use_id, question_index, clopen_message_id, platform_message_id, state, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.linkId,
				input.kind,
				input.projectId ?? null,
				input.chatSessionId ?? null,
				input.toolUseId ?? null,
				input.questionIndex ?? null,
				input.clopenMessageId ?? null,
				input.platformMessageId,
				input.state ?? 'open',
				JSON.stringify(input.payload ?? {}),
				new Date().toISOString()
			);
		return this.getById(id)!;
	},

	getById(id: string): ChannelMessageRow | null {
		return (getDatabase().prepare('SELECT * FROM channel_messages WHERE id = ?').get(id) as ChannelMessageRow | null) ?? null;
	},

	/** The row a swipe-reply or an edit points at. Newest first (rowid breaks a same-millisecond tie). */
	getByMessage(linkId: string, platformMessageId: string): ChannelMessageRow | null {
		return (getDatabase()
			.prepare('SELECT * FROM channel_messages WHERE link_id = ? AND platform_message_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
			.get(linkId, platformMessageId) as ChannelMessageRow | null) ?? null;
	},

	openQuestionsForLink(linkId: string): ChannelMessageRow[] {
		return getDatabase()
			.prepare("SELECT * FROM channel_messages WHERE link_id = ? AND kind = 'question' AND state = 'open' ORDER BY created_at")
			.all(linkId) as ChannelMessageRow[];
	},

	forToolUse(toolUseId: string): ChannelMessageRow[] {
		return getDatabase()
			.prepare("SELECT * FROM channel_messages WHERE tool_use_id = ? AND kind = 'question' ORDER BY question_index")
			.all(toolUseId) as ChannelMessageRow[];
	},

	/** Open confirmations of a chat, oldest first — a newer one may replace them. */
	openConfirmsForLink(linkId: string): ChannelMessageRow[] {
		return getDatabase()
			.prepare("SELECT * FROM channel_messages WHERE link_id = ? AND kind = 'confirm' AND state = 'open' ORDER BY created_at")
			.all(linkId) as ChannelMessageRow[];
	},

	openQuestionsForSession(chatSessionId: string): ChannelMessageRow[] {
		return getDatabase()
			.prepare("SELECT * FROM channel_messages WHERE chat_session_id = ? AND kind = 'question' AND state = 'open'")
			.all(chatSessionId) as ChannelMessageRow[];
	},

	/** The user's own prompt row for a Clopen user message, if it came from this chat. */
	getUserMessage(linkId: string, clopenMessageId: string): ChannelMessageRow | null {
		return (getDatabase()
			.prepare("SELECT * FROM channel_messages WHERE link_id = ? AND kind = 'user' AND clopen_message_id = ? LIMIT 1")
			.get(linkId, clopenMessageId) as ChannelMessageRow | null) ?? null;
	},

	setPayload(id: string, payload: unknown): void {
		getDatabase().prepare('UPDATE channel_messages SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
	},

	/** A row written before its message was sent (its id rides on the buttons) learns the message id here. */
	setPlatformMessage(id: string, platformMessageId: string): void {
		getDatabase().prepare('UPDATE channel_messages SET platform_message_id = ? WHERE id = ?').run(platformMessageId, id);
	},

	setClopenMessage(id: string, clopenMessageId: string): void {
		getDatabase().prepare('UPDATE channel_messages SET clopen_message_id = ? WHERE id = ?').run(clopenMessageId, id);
	},

	/**
	 * Move a row out of `open`. Conditional on it still being open, so two
	 * paths racing to settle one question (a tap and an answer in the web UI)
	 * cannot both act on it — the loser sees `false` and stands down.
	 */
	settle(id: string, state: Exclude<ChannelMessageState, 'open'>): boolean {
		const result = getDatabase()
			.prepare("UPDATE channel_messages SET state = ? WHERE id = ? AND state = 'open'")
			.run(state, id) as { changes: number };
		return result.changes > 0;
	},

	deleteForSession(chatSessionId: string): void {
		getDatabase().prepare('DELETE FROM channel_messages WHERE chat_session_id = ?').run(chatSessionId);
	},

	pruneBefore(isoTimestamp: string): void {
		getDatabase().prepare('DELETE FROM channel_messages WHERE created_at < ?').run(isoTimestamp);
	}
};
