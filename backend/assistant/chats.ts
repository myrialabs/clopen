/**
 * Clopen's chats — Main, and the ones the owner opens for something else.
 *
 * A chat is what the owner sees: one conversation, the same on the web and
 * in every Telegram chat that is in it (all of them are the owner's own
 * devices). Underneath, a chat is a line of sessions: the latest is where the
 * next message goes, and a fresh one continues it only when the last has
 * grown too long (see `conversation.ts`).
 *
 * Kept in settings, not tables: the list is short, and sessions that belong
 * to no other chat — everything from before chats existed included — are
 * Main's.
 *
 * One chat is ACTIVE at a time, for every place at once: the web and the
 * owner's Telegram always show the same chat. Switching on the web switches
 * Telegram (with a one-line note there), and /chats switches the web. What
 * Clopen says in a chat that is not active still reaches Telegram, named.
 */

import { getDatabase } from '$backend/database';
import { channelLinkQueries, sessionQueries, settingsQueries, type ChannelLinkRow } from '$backend/database/queries';
import type { ChatSession } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { ensureAssistantProject } from './project';

export const MAIN_CHAT = 'main';

export interface AssistantChat {
	id: string;
	/** Null for Main and for a chat not named yet (it takes its first message). */
	name: string | null;
	createdAt: string;
}

const CHATS_KEY = 'assistant:chats';
const SESSIONS_KEY = 'assistant:chat-sessions';
const ACTIVE_KEY = 'assistant:active-chat';

function read<T>(key: string, fallback: T): T {
	try {
		const value = settingsQueries.get(key)?.value;
		return value ? (JSON.parse(value) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown): void {
	settingsQueries.set(key, JSON.stringify(value));
}

/** The chats the owner opened besides Main, oldest first. */
function others(): AssistantChat[] {
	return read<AssistantChat[]>(CHATS_KEY, []);
}

/** Sessions of the chats besides Main. */
function sessionMap(): Record<string, string[]> {
	return read<Record<string, string[]>>(SESSIONS_KEY, {});
}

export function chatExists(chatId: string): boolean {
	return chatId === MAIN_CHAT || others().some((chat) => chat.id === chatId);
}

/**
 * Main first, then the others, each with the name it shows under. A chat
 * nothing was said in yet is left out — unless it is the one open now — so
 * a tapped "+" does not leave a row of "New chat"s behind.
 */
export function listChats(): Array<AssistantChat & { title: string }> {
	const main = { id: MAIN_CHAT, name: null, createdAt: '1970-01-01T00:00:00.000Z', title: 'Main' };
	const active = activeChat();
	return [
		main,
		...others()
			.filter((chat) => chat.id === active || hasMessages(chat.id))
			.map((chat) => ({ ...chat, title: chat.name ?? firstWords(chat.id) ?? 'New chat' }))
	];
}

function hasMessages(chatId: string): boolean {
	return (sessionMap()[chatId] ?? []).some((id) => (sessionQueries.getById(id)?.message_count ?? 0) > 0);
}

/** The chat every place shows now. */
export function activeChat(): string {
	const chatId = settingsQueries.get(ACTIVE_KEY)?.value ?? MAIN_CHAT;
	return chatExists(chatId) ? chatId : MAIN_CHAT;
}

/**
 * Make a chat the one every place shows. The web follows on the event; the
 * owner's Telegram hears a one-line note (unless it is where the switch was
 * made) and its next message goes there.
 */
export async function setActiveChat(chatId: string, from: 'web' | 'telegram' | 'clopen' = 'web'): Promise<void> {
	if (!chatExists(chatId)) throw new Error('That chat is closed.');
	const changed = activeChat() !== chatId;
	settingsQueries.set(ACTIVE_KEY, chatId);
	const session = await ensureChatSession(chatId);
	const project = ensureAssistantProject();
	for (const link of channelLinkQueries.listAll().filter((entry) => linkIsWithClopen(entry))) {
		if (session) channelLinkQueries.setActive(link.id, project.id, session.id);
	}
	ws.emit.global('assistant:active-chat', { chatId });
	announceChats();
	if (changed && from !== 'telegram') {
		const title = listChats().find((chat) => chat.id === chatId)?.title ?? 'Main';
		const { noteToChatApps } = await import('$backend/chat-apps/outbound');
		await noteToChatApps(`💬 ${title}`).catch(() => {});
	}
}

/** An unnamed chat takes a short name from its first message, worded by a model. */
export async function nameChatFrom(chatId: string, text: string): Promise<void> {
	const chat = others().find((entry) => entry.id === chatId);
	if (!chat || chat.name || !text.trim()) return;
	try {
		const { think } = await import('./think');
		const { name } = await think<{ name: string }>(
			`Give this conversation a name of two to four words, in the language of its first message, no quotes or punctuation at the end.\n\nFirst message: ${text.slice(0, 600)}`,
			{ type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] }
		);
		if (name?.trim() && !others().find((entry) => entry.id === chatId)?.name) renameChat(chatId, name.trim().slice(0, 40));
	} catch {
		// It keeps showing its first words.
	}
}

/** An unnamed chat is called by its first message. */
function firstWords(chatId: string): string | null {
	const sessions = sessionMap()[chatId] ?? [];
	for (const id of sessions) {
		const title = sessionQueries.getById(id)?.title;
		if (title) return title.length > 40 ? `${title.slice(0, 39)}…` : title;
	}
	return null;
}

export function createChat(name?: string | null): AssistantChat {
	const chat: AssistantChat = { id: crypto.randomUUID(), name: name?.trim() || null, createdAt: new Date().toISOString() };
	write(CHATS_KEY, [...others(), chat]);
	announceChats();
	return chat;
}

export function renameChat(chatId: string, name: string): void {
	write(
		CHATS_KEY,
		others().map((chat) => (chat.id === chatId ? { ...chat, name: name.trim() || null } : chat))
	);
	announceChats();
}

/** Close a chat: it leaves the list; its history stays in Clopen's memory. Main cannot be closed. */
export function deleteChat(chatId: string): void {
	if (chatId === MAIN_CHAT) throw new Error('Main cannot be closed.');
	// Every place that showed it falls back to Main.
	const wasActive = activeChat() === chatId;
	write(CHATS_KEY, others().filter((chat) => chat.id !== chatId));
	if (wasActive) void setActiveChat(MAIN_CHAT, 'clopen');
	announceChats();
}

/** The owner's sessions with Clopen (not task, flow or system runs). */
export function ownerSessionIds(): string[] {
	const project = ensureAssistantProject();
	return (getDatabase()
		.prepare(`SELECT id FROM chat_sessions WHERE project_id = ? AND (origin IS NULL OR origin = 'owner')`)
		.all(project.id) as Array<{ id: string }>).map((row) => row.id);
}

/** Every session that has been part of a chat, oldest line first. */
export function sessionsOfChat(chatId: string): string[] {
	const map = sessionMap();
	if (chatId !== MAIN_CHAT) return map[chatId] ?? [];
	const elsewhere = new Set(Object.values(map).flat());
	return ownerSessionIds().filter((id) => !elsewhere.has(id));
}

export function chatOfSession(sessionId: string): string {
	for (const [chatId, sessions] of Object.entries(sessionMap())) if (sessions.includes(sessionId)) return chatExists(chatId) ? chatId : MAIN_CHAT;
	return MAIN_CHAT;
}

/** A session (new, or a handover) now belongs to this chat. Main needs no record. */
export function attachSession(chatId: string, sessionId: string): void {
	if (chatId === MAIN_CHAT) return;
	const map = sessionMap();
	if (map[chatId]?.includes(sessionId)) return;
	map[chatId] = [...(map[chatId] ?? []), sessionId];
	write(SESSIONS_KEY, map);
}

/** Where the chat's next message goes: its most recent session. */
export function currentSessionOf(chatId: string): ChatSession | null {
	const ids = new Set(sessionsOfChat(chatId));
	if (!ids.size) return null;
	const project = ensureAssistantProject();
	return (
		sessionQueries
			.getByProjectId(project.id)
			.filter((session) => ids.has(session.id))
			.sort((a, b) => (b.last_message_at ?? b.started_at).localeCompare(a.last_message_at ?? a.started_at))[0] ?? null
	);
}

// ── Telegram (and any chat app) ─────────────────────────────────────────────

/** Which of Clopen's chats a chat app is in: the active one — the same as the web. */
export function chatOfLink(_link: ChannelLinkRow): string {
	return activeChat();
}

/** A chat app that is talking to Clopen (not switched into a project). */
export function linkIsWithClopen(link: ChannelLinkRow): boolean {
	const clopen = ensureAssistantProject().id;
	if (link.active_project_id) return link.active_project_id === clopen;
	if (!link.active_session_id) return true;
	return sessionQueries.getById(link.active_session_id)?.project_id === clopen;
}

/** The chat apps talking to Clopen — the owner's Telegram. */
export function clopenLinks(accountIds: string[]): ChannelLinkRow[] {
	return accountIds
		.flatMap((accountId) => channelLinkQueries.listByAccount(accountId))
		.filter((link) => channelLinkQueries.isActive(link) && linkIsWithClopen(link));
}

/** The chat apps showing a chat right now: all of them when it is the active chat, none otherwise. */
export function linksInChat(chatId: string, accountIds: string[]): ChannelLinkRow[] {
	return chatId === activeChat() ? clopenLinks(accountIds) : [];
}

function announceChats(): void {
	ws.emit.global('assistant:chats', { chats: listChats() });
}

/**
 * The chat's current session, made now when it has none yet — a chat app
 * switching into a chat just opened must have somewhere to be.
 */
export async function ensureChatSession(chatId: string): Promise<ChatSession | null> {
	const current = currentSessionOf(chatId);
	if (current) return current;
	const { createSession, pickModel } = await import('$backend/control/workspace');
	const { getOwner } = await import('$backend/auth/auth-service');
	const owner = getOwner();
	const project = ensureAssistantProject();
	const model = owner ? pickModel(owner.id, project.id) : null;
	if (!model) return null;
	const session = createSession(project, model);
	attachSession(chatId, session.id);
	return session;
}
