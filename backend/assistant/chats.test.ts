/**
 * Clopen's chats: Main holds every session no other chat claims, a chat the
 * owner opens keeps its own line of sessions, and closing one leaves its
 * sessions to nobody (chat apps in it fall back to Main).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { sessionQueries } from '$backend/database/queries';
import { ensureAssistantProject } from './project';
import { activeChat, attachSession, chatOfSession, createChat, currentSessionOf, deleteChat, listChats, MAIN_CHAT, sessionsOfChat, setActiveChat } from './chats';

let mainSession = '';
let otherSession = '';

beforeAll(async () => {
	await initializeDatabase();
	const project = ensureAssistantProject();
	mainSession = sessionQueries.create({ project_id: project.id, title: 'Weather app', started_at: new Date().toISOString() } as never).id;
	otherSession = sessionQueries.create({ project_id: project.id, title: 'Offer letter', started_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	closeDatabase();
});

describe('chats', () => {
	it('keeps sessions in Main until a chat claims them', () => {
		expect(chatOfSession(mainSession)).toBe(MAIN_CHAT);
		expect(sessionsOfChat(MAIN_CHAT)).toContain(otherSession);
	});

	it('gives an opened chat its own sessions, named by its first message', async () => {
		const chat = createChat(null);
		attachSession(chat.id, otherSession);
		expect(chatOfSession(otherSession)).toBe(chat.id);
		expect(sessionsOfChat(chat.id)).toEqual([otherSession]);
		expect(sessionsOfChat(MAIN_CHAT)).not.toContain(otherSession);
		expect(currentSessionOf(chat.id)?.id).toBe(otherSession);
		// Nothing said in it yet, and not the open chat: not listed, so a tapped "+" leaves no empty rows.
		expect(listChats().some((entry) => entry.id === chat.id)).toBe(false);
		await setActiveChat(chat.id);
		expect(activeChat()).toBe(chat.id);
		expect(listChats().find((entry) => entry.id === chat.id)?.title).toBe('Offer letter');
		expect(listChats()[0].id).toBe(MAIN_CHAT);

		deleteChat(chat.id);
		expect(listChats().some((entry) => entry.id === chat.id)).toBe(false);
		expect(chatOfSession(otherSession)).toBe(MAIN_CHAT);
		expect(activeChat()).toBe(MAIN_CHAT);
	});

	it('never closes Main', () => {
		expect(() => deleteChat(MAIN_CHAT)).toThrow();
	});
});
