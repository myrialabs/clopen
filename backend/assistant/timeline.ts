/**
 * A chat with Clopen as the owner sees it — the way Telegram shows it.
 *
 * Each of Clopen's chats (Main, and the ones the owner opened) is a line of
 * sessions underneath (`chats.ts`). Its timeline shows only what was said —
 * the owner's messages, marked with where they were typed (web or Telegram),
 * Clopen's answer to each turn (its last words, never what it wrote between
 * tools) and what Clopen sent on its own for that chat (results, reminders,
 * files). "Clear chat" hides what came before from view; Clopen's memory
 * keeps it.
 *
 * Kept in a light table (`assistant_timeline`) as turns happen, so a chat
 * opens without walking every message ever saved.
 *
 * The table is the one record of the chat: the web shows its rows, and the
 * owner's Telegram is sent the same rows — the owner's web messages mirrored,
 * Clopen's quick words (`sayLine`), each turn's answer — each once, tracked by
 * row id. Nothing reaches one place that the other does not keep.
 */

import { getDatabase } from '$backend/database';
import { inboxQueries, missionQueries, sessionQueries, settingsQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { InboxItem } from '$shared/types/assistant';
import { routeAssistantMessage } from './conversation';
import { activeChat, attachSession, chatOfSession, currentSessionOf, ensureChatSession, MAIN_CHAT, nameChatFrom, ownerSessionIds, sessionsOfChat, setActiveChat } from './chats';
import { shareBytes } from './files';
import { ensureAssistantProject } from './project';
import { sendPromptAsOwner } from './prompt';
import { toInboxItem } from './mappers';

const CLEARED_KEY = 'assistant:timeline-cleared-at';
/** Bumped when what the table holds changes; the table is then rebuilt from the messages. */
const REVISION_KEY = 'assistant:timeline-revision';
const REVISION = '2';

export interface TimelineFile {
	id: string;
	filename: string;
	mime: string;
	url: string;
}

export interface TimelineEntry {
	id: string;
	at: string;
	from: 'owner' | 'clopen';
	text: string;
	/** Files Clopen sent (served by /api/assistant/files). */
	files: TimelineFile[];
	/** Attachments the owner sent: a name, and where to see it when it was kept. */
	attached: OwnerAttachment[];
	kind: 'message' | 'update';
	/** Where the owner typed it. */
	source?: 'web' | 'telegram';
	/** The owner changed it after sending; what it said before. */
	edited?: { before: string; at: string };
}

export interface OwnerAttachment {
	name: string;
	mime?: string;
	/** Served by /api/assistant/files when the bytes were kept at receipt. */
	url?: string;
	id?: string;
}

/**
 * What a row keeps beside its text. Rows written before this held a plain
 * list of names; both are read.
 */
interface RowMeta {
	attached: OwnerAttachment[];
	source?: 'web' | 'telegram';
	edited?: { before: string; at: string };
	/** A line of Clopen's that answers one message (a quick word): that message's row. */
	answers?: string;
}

function readMeta(raw: string): RowMeta {
	try {
		const value = JSON.parse(raw) as unknown;
		if (Array.isArray(value)) return { attached: value.map((name) => (typeof name === 'string' ? { name } : (name as OwnerAttachment))) };
		if (value && typeof value === 'object') {
			const meta = value as Partial<RowMeta>;
			return { attached: meta.attached ?? [], source: meta.source, edited: meta.edited, answers: meta.answers };
		}
	} catch {
		// Kept as nothing beside the text.
	}
	return { attached: [] };
}

const clearedKey = (chatId: string) => (chatId === MAIN_CHAT ? CLEARED_KEY : `${CLEARED_KEY}:${chatId}`);

export function clearedAt(chatId: string = MAIN_CHAT): string {
	return settingsQueries.get(clearedKey(chatId))?.value ?? '1970-01-01T00:00:00.000Z';
}

/** Hide everything said so far in a chat from view (memory keeps it). */
export function clearTimeline(chatId: string = MAIN_CHAT): void {
	settingsQueries.set(clearedKey(chatId), new Date().toISOString());
	announce(chatId);
}

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block: { type?: string }) => block?.type === 'text')
		.map((block: { text?: string }) => block.text ?? '')
		.join('\n')
		.trim();
}

/** A user message that only carries tool results: part of Clopen's turn, not a new one. */
function onlyToolResults(content: unknown): boolean {
	return Array.isArray(content) && content.length > 0 && content.every((block: { type?: string }) => block?.type === 'tool_result');
}

function tableReady(): boolean {
	return Boolean(getDatabase().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_timeline'`).get());
}

interface Said {
	id: string;
	at: string;
	from: 'owner' | 'clopen';
	text: string;
	attached: string[];
}

/**
 * What a run of one session's messages says, as the owner sees it: each of
 * their messages, and per turn the last thing Clopen wrote. A turn starts
 * with a message from the owner (or a note Clopen sent itself, "[Clopen ·
 * connected]") — never with a tool result, which is stored as a user message
 * but belongs to the turn it is in. A turn's answer is keyed by the message
 * that opened it, so a later look replaces it instead of adding one.
 */
function readSession(sessionId: string, from: string): Said[] {
	const rows = getDatabase()
		.prepare(
			`SELECT id, created_at, data FROM messages
			 WHERE session_id = ? AND is_deleted = 0 AND created_at >= ?
			   AND json_extract(data, '$.type') IN ('user', 'assistant')
			 ORDER BY created_at ASC`
		)
		.all(sessionId, from) as Array<{ id: string; created_at: string; data: string }>;
	const said: Said[] = [];
	let turn: string | null = null;
	let answer: Said | null = null;
	const flush = () => {
		if (answer?.text) said.push(answer);
		answer = null;
	};
	for (const row of rows) {
		let message: { type?: string; content?: unknown; parent?: { toolUseId?: string | null }; synthetic?: boolean };
		try {
			message = JSON.parse(row.data);
		} catch {
			continue;
		}
		if (message.type === 'user') {
			if (message.parent?.toolUseId || onlyToolResults(message.content)) continue;
			const text = textOf(message.content);
			const attached = Array.isArray(message.content)
				? message.content.filter((block: { type?: string }) => block?.type === 'image' || block?.type === 'document').map((block: { title?: string | null; type?: string }) => block.title || block.type || 'file')
				: [];
			if (!text && !attached.length) continue;
			flush();
			turn = row.id;
			// Clopen's notes to itself ("[Clopen · connected]") open a turn but are not the owner talking.
			if (!message.synthetic && !text.startsWith('[Clopen')) said.push({ id: row.id, at: row.created_at, from: 'owner', text, attached });
		} else if (message.parent?.toolUseId == null) {
			const text = textOf(message.content);
			if (text) answer = { id: `answer:${turn ?? row.id}`, at: row.created_at, from: 'clopen', text, attached: [] };
		}
	}
	flush();
	return said;
}

/**
 * Bring one session's part of the timeline up to date — from the last thing
 * the owner said in it that has a turn, so the turn in flight is read again
 * and its answer replaced. Cheap: one session, from one point on.
 *
 * The point is that message's time in `messages`, never the row's: a row
 * keeps when the owner sent it, and a message that waited behind a busy turn
 * is saved later — reading from the earlier time would start in the middle
 * of the turn before it and key that turn's answer to the wrong message.
 */
export function syncTimelineSession(sessionId: string): void {
	if (!tableReady()) return;
	const db = getDatabase();
	const last = db
		.prepare(
			`SELECT m.created_at FROM assistant_timeline t JOIN messages m ON m.id = t.id
			 WHERE t.session_id = ? AND t.sender = 'owner' AND m.is_deleted = 0
			 ORDER BY m.created_at DESC LIMIT 1`
		)
		.get(sessionId) as { created_at: string } | undefined;
	const from = last?.created_at ?? '1970-01-01T00:00:00.000Z';
	const write = db.prepare(
		`INSERT INTO assistant_timeline (id, session_id, sender, text, attached, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   -- A row written when the message arrived keeps what it knew then (where it came from,
		   -- the photos it kept, an edit, the time it arrived); the saved message only fills the rest.
		   text = CASE WHEN assistant_timeline.attached LIKE '%"edited"%' THEN assistant_timeline.text ELSE excluded.text END,
		   attached = CASE WHEN substr(assistant_timeline.attached, 1, 1) = '{' THEN assistant_timeline.attached ELSE excluded.attached END,
		   created_at = CASE WHEN assistant_timeline.sender = 'owner' THEN assistant_timeline.created_at ELSE excluded.created_at END`
	);
	// Answers of the turns being re-read go first: a turn re-read under the old rule may have left one per tool call.
	// Quick words are lines of their own, written once, and stay.
	const clearAnswers = db.prepare(`DELETE FROM assistant_timeline WHERE session_id = ? AND sender = 'clopen' AND id LIKE 'answer:%' AND created_at >= ?`);
	const writeAll = () => {
		clearAnswers.run(sessionId, from);
		for (const item of readSession(sessionId, from)) write.run(item.id, sessionId, item.from, item.text, JSON.stringify(item.attached), item.at);
	};
	if (db.transaction) db.transaction(writeAll)();
	else writeAll();
}

/** The chat a report belongs to: the one whose turn started the task, else Main. */
export function chatOfItem(item: InboxItem): string {
	if (item.sessionId) {
		const chat = chatOfSession(item.sessionId);
		if (chat !== MAIN_CHAT || sessionQueries.getById(item.sessionId)?.project_id === ensureAssistantProject().id) return chat;
	}
	if (item.missionId) {
		const started = missionQueries.getById(item.missionId)?.assistant_session_id;
		if (started) return chatOfSession(started);
	}
	return MAIN_CHAT;
}

/** A chat's conversation, newest last. `before` pages back in time. */
export function timeline(options: { chatId?: string; before?: string | null; limit?: number } = {}): { entries: TimelineEntry[]; more: boolean; working: boolean } {
	const chatId = options.chatId ?? MAIN_CHAT;
	const project = ensureAssistantProject();
	const sessions = sessionsOfChat(chatId);
	const since = clearedAt(chatId);
	const until = options.before ?? '9999-12-31T00:00:00.000Z';
	const limit = Math.min(options.limit ?? 60, 200);
	const entries: TimelineEntry[] = [];

	if (sessions.length && tableReady()) {
		const marks = sessions.map(() => '?').join(', ');
		const rows = getDatabase()
			.prepare(
				`SELECT t.id, t.sender, t.text, t.attached, t.created_at,
				        EXISTS (SELECT 1 FROM channel_messages c WHERE c.kind = 'user' AND c.clopen_message_id = t.id) AS from_chat_app
				 FROM assistant_timeline t
				 WHERE t.session_id IN (${marks}) AND t.created_at > ? AND t.created_at < ?
				 ORDER BY t.created_at DESC LIMIT ?`
			)
			.all(...sessions, since, until, limit + 1) as Array<{ id: string; sender: 'owner' | 'clopen'; text: string; attached: string; created_at: string; from_chat_app: number }>;
		for (const row of rows) {
			const meta = readMeta(row.attached);
			entries.push({
				id: row.id,
				at: row.created_at,
				from: row.sender,
				text: row.text,
				files: [],
				attached: meta.attached,
				kind: 'message',
				...(row.sender === 'owner' ? { source: meta.source ?? (row.from_chat_app ? ('telegram' as const) : ('web' as const)) } : {}),
				...(meta.edited ? { edited: meta.edited } : {})
			});
		}
	}

	// What Clopen sent on its own for this chat: results, reminders, files — not questions (those are cards).
	for (const item of inboxQueries.list({ status: 'all', limit: 200 }).map(toInboxItem)) {
		if (item.kind !== 'report' || item.status === 'dismissed' || item.createdAt <= since || item.createdAt >= until) continue;
		if (chatOfItem(item) !== chatId) continue;
		const files = Array.isArray(item.data.files) ? (item.data.files as TimelineFile[]) : [];
		entries.push({ id: `update:${item.id}`, at: item.createdAt, from: 'clopen', text: item.body || item.title, files, attached: [], kind: 'update' });
	}

	entries.sort((a, b) => a.at.localeCompare(b.at));
	const more = entries.length > limit;
	return { entries: entries.slice(-limit), more, working: isWorking(project.id, sessions) };
}

function isWorking(projectId: string, sessions: string[]): boolean {
	return sessions.some((id) => streamManager.getSessionStream(id, projectId)?.status === 'active');
}

/**
 * Where a chat's next message goes: its current session, or a fresh one that
 * continues it when that has grown too long. A message sent while Clopen is
 * still answering waits behind that turn in the same session.
 */
export function sessionForNextMessage(chatId: string, text: string) {
	const current = currentSessionOf(chatId);
	const decision = routeAssistantMessage({ sessionId: current?.id ?? null, text });
	if (decision.changed && decision.sessionId) attachSession(chatId, decision.sessionId);
	return decision.sessionId ? sessionQueries.getById(decision.sessionId) : null;
}

export type IncomingAttachment = { type: 'image' | 'document'; mediaType: string; data: string; title: string };

/**
 * The one record of something the owner said: written the moment it
 * arrives — from the web or Telegram — under the id its prompt will be saved
 * with, and updated in place while it is still coming in (the photos of an
 * album, a thought sent in pieces). Every screen shows this row; nothing
 * guesses at a message from its pieces. Photos and files are kept so every
 * screen can show them.
 */
export function receiveOwnerMessage(input: {
	id?: string;
	sessionId: string;
	text: string;
	attachments?: IncomingAttachment[];
	/** Already kept (a burst growing): reused instead of kept again. */
	kept?: OwnerAttachment[];
	source: 'web' | 'telegram';
}): { id: string; kept: OwnerAttachment[] } {
	const id = input.id ?? crypto.randomUUID();
	const kept = [...(input.kept ?? [])];
	for (const file of input.attachments ?? []) {
		try {
			const shared = shareBytes(Buffer.from(file.data, 'base64'), file.title || (file.type === 'image' ? 'photo.jpg' : 'file'), file.mediaType);
			kept.push({ name: shared.filename, mime: shared.mime, url: shared.url, id: shared.id });
		} catch (error) {
			debug.warn('assistant', 'Keeping an attachment failed:', error);
			kept.push({ name: file.title || 'file', mime: file.mediaType });
		}
	}
	if (tableReady()) {
		const existing = getDatabase().prepare('SELECT attached FROM assistant_timeline WHERE id = ?').get(id) as { attached: string } | undefined;
		const meta: RowMeta = { ...(existing ? readMeta(existing.attached) : { attached: [] }), attached: kept, source: input.source };
		getDatabase()
			.prepare(
				`INSERT INTO assistant_timeline (id, session_id, sender, text, attached, created_at) VALUES (?, ?, 'owner', ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET text = excluded.text, attached = excluded.attached`
			)
			.run(id, input.sessionId, input.text.trim(), JSON.stringify(meta), new Date().toISOString());
	}
	announce(chatOfSession(input.sessionId));
	return { id, kept };
}

/**
 * A line of the owner's that is not a prompt — the answer they gave a card
 * ("🔒 Masuk ke Google Calendar · arga@… · ••••••"), shown where they gave it
 * like anything else they said.
 */
export function recordOwnerLine(input: { id: string; sessionId: string | null; text: string; source: 'web' | 'telegram' }): string | null {
	// The chat that asked, when Clopen asked; a task agent's card lands in the chat that is open.
	const asker = input.sessionId ? sessionQueries.getById(input.sessionId) : null;
	const ownChat = asker && asker.project_id === ensureAssistantProject().id && ownerSessionIds().includes(asker.id);
	const sessionId = ownChat ? asker.id : (currentSessionOf(activeChat())?.id ?? null);
	if (!sessionId) return null;
	receiveOwnerMessage({ id: input.id, sessionId, text: input.text, source: input.source });
	return sessionId;
}

/** Whether the chat already has this line. */
export function hasLine(id: string): boolean {
	return tableReady() && Boolean(getDatabase().prepare('SELECT 1 FROM assistant_timeline WHERE id = ?').get(id));
}

/**
 * Clopen says a line that is not a turn's answer — the quick word a message
 * gets while the work behind it runs. Written once as a row (the web shows
 * it, a refresh keeps it), then sent to the owner's Telegram as a reply to
 * the message it answers.
 */
export async function sayLine(input: { id: string; sessionId: string; text: string; answers?: string | null }): Promise<void> {
	const text = input.text.trim();
	if (!tableReady() || !text) return;
	const meta: RowMeta = { attached: [], ...(input.answers ? { answers: input.answers } : {}) };
	const written = getDatabase()
		.prepare(`INSERT OR IGNORE INTO assistant_timeline (id, session_id, sender, text, attached, created_at) VALUES (?, ?, 'clopen', ?, ?, ?)`)
		.run(input.id, input.sessionId, text, JSON.stringify(meta), new Date().toISOString()) as { changes: number };
	if (!written.changes) return;
	const chatId = chatOfSession(input.sessionId);
	announce(chatId);
	const { deliverLine } = await import('$backend/chat-apps/outbound');
	await deliverLine(chatId, { id: input.id, text, replyTo: input.answers ?? null }).catch((error: unknown) => debug.warn('assistant', 'Sending a line to chat apps failed:', error));
}

/** The owner says something in a chat on the web. `id` is the one the screen already shows it under. */
export async function say(input: { chatId?: string; id?: string; text: string; attachments?: IncomingAttachment[] }): Promise<{ id: string }> {
	const chatId = input.chatId ?? MAIN_CHAT;
	const project = ensureAssistantProject();
	if (chatId !== activeChat()) await setActiveChat(chatId, 'web');
	const session = sessionForNextMessage(chatId, input.text) ?? (await ensureChatSession(chatId));
	if (!session) throw new Error('No AI model is set up yet.');
	const { id } = receiveOwnerMessage({ id: input.id, sessionId: session.id, text: input.text, attachments: input.attachments, source: 'web' });
	// The owner's Telegram sees what was typed on the web, before its answer.
	const { mirrorOwnerMessage } = await import('$backend/chat-apps/outbound');
	void mirrorOwnerMessage(chatId, input.text, { attachments: input.attachments?.length ?? 0, fromLinkId: null, rowId: id }).catch((error: unknown) => debug.warn('assistant', 'Mirroring a message to chat apps failed:', error));
	const sent = await sendPromptAsOwner({ project, session, text: input.text, attachments: input.attachments, origin: 'owner', messageId: id });
	attachSession(chatId, sent.session.id);
	void nameChatFrom(chatId, input.text);
	if (sent.outcome === 'queued') void ackQueued(sent.session.id, input.text, id);
	announce(chatId);
	return { id };
}

/**
 * The owner changed a message after sending it — on the web or in Telegram.
 * Nothing is deleted and nothing branches (that is a project chat's way):
 * the row shows the new words, marked edited, and Clopen hears the change.
 * Still waiting in the queue: the queued words are replaced. Being answered:
 * that answer stops and the new words are answered instead. Answered: Clopen
 * redoes or adjusts what it did for it.
 */
export async function editOwnerMessage(input: { id: string; text: string; from: 'web' | 'telegram'; recordOnly?: boolean }): Promise<void> {
	const text = input.text.trim();
	if (!text || !tableReady()) return;
	const row = getDatabase().prepare(`SELECT id, session_id, text, attached FROM assistant_timeline WHERE id = ? AND sender = 'owner'`).get(input.id) as
		| { id: string; session_id: string; text: string; attached: string }
		| undefined;
	if (!row) throw new Error('That message is not in this chat.');
	if (row.text === text) return;
	const meta = readMeta(row.attached);
	meta.edited = { before: meta.edited?.before ?? row.text, at: new Date().toISOString() };
	getDatabase().prepare('UPDATE assistant_timeline SET text = ?, attached = ? WHERE id = ?').run(text, JSON.stringify(meta), row.id);
	const chatId = chatOfSession(row.session_id);
	announce(chatId);
	if (input.recordOnly) return;

	const { replaceQueuedPrompt } = await import('./prompt');
	if (await replaceQueuedPrompt(row.id, text)) return;

	const project = ensureAssistantProject();
	const stream = streamManager.getSessionStream(row.session_id, project.id);
	const answering = stream?.status === 'active';
	if (answering) await streamManager.cancelStream(stream.streamId, 'edited-by-owner').catch(() => false);
	const session = sessionQueries.getById(row.session_id);
	if (session) {
		await sendPromptAsOwner({
			project,
			session,
			synthetic: true,
			text: answering
				? `[Clopen · edited] The owner changed the message you were answering from "${row.text.slice(0, 800)}" to "${text.slice(0, 1500)}". Answer the new words instead.`
				: `[Clopen · edited] The owner changed an earlier message from "${row.text.slice(0, 800)}" to "${text.slice(0, 1500)}". Act on the change: answer it again if your answer no longer fits, and change any task it started. Do not mention this note.`
		});
	}
	if (input.from === 'web') {
		const { editMirroredMessage } = await import('$backend/chat-apps/outbound');
		void editMirroredMessage(row.id, text).catch(() => {});
	}
}

/** A message that waits behind a busy turn gets a quick word now, in the owner's language, not a canned line. */
async function ackQueued(sessionId: string, text: string, messageId: string): Promise<void> {
	const { ackNow } = await import('./ack');
	await ackNow(sessionId, text, messageId).catch(() => {});
}

/** Stop whatever Clopen is answering right now in a chat. */
export async function stopWorking(chatId: string = MAIN_CHAT): Promise<number> {
	const project = ensureAssistantProject();
	let stopped = 0;
	for (const id of sessionsOfChat(chatId)) {
		const stream = streamManager.getSessionStream(id, project.id);
		if (stream?.status === 'active' && (await streamManager.cancelStream(stream.streamId, 'stopped-by-owner'))) stopped += 1;
	}
	announce(chatId);
	return stopped;
}

const announceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Tell open screens a chat changed (coalesced per chat). */
export function announce(chatId: string = MAIN_CHAT): void {
	if (announceTimers.has(chatId)) return;
	announceTimers.set(
		chatId,
		setTimeout(() => {
			announceTimers.delete(chatId);
			try {
				const project = ensureAssistantProject();
				ws.emit.global('assistant:timeline', { chatId, working: isWorking(project.id, sessionsOfChat(chatId)) });
			} catch (error) {
				debug.warn('assistant', 'Announcing the timeline failed:', error);
			}
		}, 250)
	);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Sync a session soon (coalesced), then tell open screens of its chat. */
function syncSoon(sessionId: string, delay = 150): void {
	const timer = pending.get(sessionId);
	if (timer) clearTimeout(timer);
	pending.set(
		sessionId,
		setTimeout(() => {
			pending.delete(sessionId);
			try {
				syncTimelineSession(sessionId);
			} catch (error) {
				debug.warn('assistant', 'Updating the timeline failed:', error);
			}
			announce(chatOfSession(sessionId));
		}, delay)
	);
}

function isOwnerChat(projectId: string | undefined, sessionId: string | undefined): sessionId is string {
	if (!projectId || !sessionId) return false;
	try {
		if (projectId !== ensureAssistantProject().id) return false;
	} catch {
		return false;
	}
	const origin = (sessionQueries.getById(sessionId) as { origin?: string | null } | null)?.origin ?? null;
	return origin === null || origin === 'owner';
}

/** Messages already given another go — once each. */
const retried = new Set<string>();
const UNANSWERED_AFTER_MS = 90_000;
const UNANSWERED_WINDOW_MS = 30 * 60_000;

/**
 * Nothing the owner says goes unanswered. A message that was saved but never
 * got a turn — it arrived while Clopen was starting, its turn failed before a
 * word, the server went down mid-way — gets one more go: no turn is running
 * for it, nothing is queued, and no answer came after it within 90 seconds.
 */
async function answerTheUnanswered(): Promise<void> {
	if (!tableReady()) return;
	const project = ensureAssistantProject();
	const now = Date.now();
	const rows = getDatabase()
		.prepare(
			`SELECT t.id, t.session_id, t.created_at FROM assistant_timeline t
			 WHERE t.sender = 'owner' AND t.id NOT LIKE 'card:%' AND t.created_at > ? AND t.created_at < ?
			   AND NOT EXISTS (SELECT 1 FROM assistant_timeline a WHERE a.session_id = t.session_id AND a.sender = 'clopen' AND a.id NOT LIKE 'ack:%' AND a.created_at > t.created_at)
			   AND EXISTS (SELECT 1 FROM messages m WHERE m.id = t.id AND m.is_deleted = 0)`
		)
		.all(new Date(now - UNANSWERED_WINDOW_MS).toISOString(), new Date(now - UNANSWERED_AFTER_MS).toISOString()) as Array<{ id: string; session_id: string; created_at: string }>;
	for (const row of rows) {
		if (retried.has(row.id)) continue;
		if (streamManager.getSessionStream(row.session_id, project.id)?.status === 'active') continue;
		// A later message in the same chat has its own turn, which reads this one too.
		const later = getDatabase().prepare(`SELECT 1 FROM assistant_timeline WHERE session_id = ? AND sender = 'owner' AND created_at > ? LIMIT 1`).get(row.session_id, row.created_at);
		if (later) continue;
		retried.add(row.id);
		const session = sessionQueries.getById(row.session_id);
		if (!session) continue;
		debug.log('assistant', `Message ${row.id} got no answer; giving it another go`);
		await sendPromptAsOwner({ project, session, synthetic: true, text: '[Clopen · retry] The owner\'s last message above got no answer (the turn did not run). Answer it now, as if it had just arrived.' }).catch((error) =>
			debug.warn('assistant', 'Answering an unanswered message failed:', error)
		);
	}
}

/** Rebuild the table from the messages when what it holds changed shape (and on first start). */
function rebuildIfStale(): void {
	if (!tableReady()) return;
	const db = getDatabase();
	if (settingsQueries.get(REVISION_KEY)?.value !== REVISION) {
		db.prepare('DELETE FROM assistant_timeline').run();
		settingsQueries.set(REVISION_KEY, REVISION);
	}
	for (const sessionId of ownerSessionIds()) syncTimelineSession(sessionId);
}

/**
 * Keep the timeline and open screens current: a message the owner sent, an
 * answer saved, a turn ended in one of Clopen's sessions. The end of a turn
 * is read twice — its last words can land just after the turn says it ended.
 */
export function initTimeline(): void {
	streamManager.on('stream:message', (payload: { projectId?: string; chatSessionId?: string; event: { data?: { message?: { type?: string } } } }) => {
		const type = payload.event.data?.message?.type;
		if ((type === 'user' || type === 'assistant') && isOwnerChat(payload.projectId, payload.chatSessionId)) syncSoon(payload.chatSessionId, type === 'user' ? 150 : 600);
	});
	streamManager.on('stream:lifecycle', (event: { projectId?: string; chatSessionId?: string }) => {
		if (!isOwnerChat(event.projectId, event.chatSessionId)) return;
		const sessionId = event.chatSessionId;
		syncSoon(sessionId, 200);
		setTimeout(() => syncSoon(sessionId, 0), 2000);
	});
	streamManager.on('session:cleanup', (sessionId: string) => {
		if (!tableReady()) return;
		getDatabase().prepare('DELETE FROM assistant_timeline WHERE session_id = ?').run(sessionId);
		announce(chatOfSession(sessionId));
	});
	setTimeout(() => {
		try {
			rebuildIfStale();
			announce();
		} catch (error) {
			debug.warn('assistant', 'Filling the timeline failed:', error);
		}
	}, 3000);
	setInterval(() => void answerTheUnanswered().catch((error) => debug.warn('assistant', 'Checking for unanswered messages failed:', error)), 30_000).unref?.();
}
