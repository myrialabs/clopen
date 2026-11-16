/**
 * Clopen's one conversation is kept in a light table as turns happen: the
 * owner's messages and, per turn, the last thing Clopen wrote — never what it
 * wrote between tools, never twice for the same turn.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, getDatabase, initializeDatabase } from '$backend/database';
import { messageQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';
import { ensureAssistantProject } from './project';
import { editOwnerMessage, receiveOwnerMessage, sayLine, syncTimelineSession, timeline } from './timeline';

let sessionId = '';
let clock = Date.parse('2026-01-01T10:00:00.000Z');

function say(type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}, preferredId?: string): void {
	clock += 1000;
	const timestamp = new Date(clock).toISOString();
	const head = sessionQueries.getHead(sessionId);
	const saved = messageQueries.create({
		session_id: sessionId,
		message: { type, content, createdAt: timestamp, parent: { messageId: head, sessionId: null, toolUseId: null }, ...extra } as unknown as UnifiedMessage,
		timestamp,
		parent_message_id: head ?? undefined,
		preferred_id: preferredId
	});
	sessionQueries.updateHead(sessionId, saved.id);
}

beforeAll(async () => {
	await initializeDatabase();
	// The test database outlives a run: start from an empty conversation.
	getDatabase().prepare('DELETE FROM assistant_timeline').run();
	const project = ensureAssistantProject();
	sessionId = sessionQueries.create({ project_id: project.id, title: 'Timeline', started_at: new Date(clock).toISOString() } as never).id;
});

afterAll(() => {
	closeDatabase();
});

describe('timeline', () => {
	it('keeps what the owner said and the answer each turn ended with', () => {
		say('user', [{ type: 'text', text: 'How much is BTC?' }]);
		say('assistant', [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'browse', input: {} }]);
		say('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { parent: { messageId: null, sessionId: null, toolUseId: 't1' } });
		say('assistant', [{ type: 'text', text: 'BTC is 100k.' }]);
		syncTimelineSession(sessionId);

		const said = timeline().entries.filter((entry) => entry.kind === 'message').map((entry) => `${entry.from}: ${entry.text}`);
		expect(said).toEqual(['owner: How much is BTC?', 'clopen: BTC is 100k.']);
	});

	it('adds the next turn without repeating the last one', () => {
		say('user', [{ type: 'text', text: 'And ETH?' }]);
		say('assistant', [{ type: 'text', text: 'ETH is 5k.' }]);
		syncTimelineSession(sessionId);
		syncTimelineSession(sessionId);

		const said = timeline().entries.filter((entry) => entry.kind === 'message').map((entry) => `${entry.from}: ${entry.text}`);
		expect(said).toEqual(['owner: How much is BTC?', 'clopen: BTC is 100k.', 'owner: And ETH?', 'clopen: ETH is 5k.']);
	});

	it('keeps one row for a message from the moment it arrives, through its saved prompt', async () => {
		const id = crypto.randomUUID();
		// Arrives from Telegram in two pieces (an album): one row, grown in place.
		const first = receiveOwnerMessage({ id, sessionId, text: 'kalo ini?', source: 'telegram' });
		receiveOwnerMessage({ id, sessionId, text: 'kalo ini?', kept: first.kept, source: 'telegram' });
		// The turn takes it under the same id; a resync must not duplicate it or lose where it came from.
		say('user', [{ type: 'text', text: 'kalo ini?' }], {}, id);
		say('assistant', [{ type: 'text', text: 'Itu video publik.' }]);
		syncTimelineSession(sessionId);
		const rows = timeline().entries.filter((entry) => entry.id === id);
		expect(rows).toHaveLength(1);
		expect(rows[0].source).toBe('telegram');

		// Edited: the new words stay through a resync, with what it said before.
		await editOwnerMessage({ id, text: 'kalo yang ini?', from: 'web', recordOnly: true });
		syncTimelineSession(sessionId);
		const edited = timeline().entries.find((entry) => entry.id === id)!;
		expect(edited.text).toBe('kalo yang ini?');
		expect(edited.edited?.before).toBe('kalo ini?');
	});

	it('keys each answer to its own turn when a message waited behind a busy one', async () => {
		// The first message's turn starts...
		const firstId = crypto.randomUUID();
		receiveOwnerMessage({ id: firstId, sessionId, text: 'Make a retro notes app', source: 'telegram' });
		say('user', [{ type: 'text', text: 'Make a retro notes app' }], {}, firstId);
		// Rows keep when the owner sent them; this test's clock stands in for now.
		getDatabase().prepare('UPDATE assistant_timeline SET created_at = ? WHERE id = ?').run(new Date(clock - 100).toISOString(), firstId);
		// ...a second one arrives while it runs: its row is written now, its message only once it gets a turn.
		const secondId = crypto.randomUUID();
		receiveOwnerMessage({ id: secondId, sessionId, text: 'Make it 8-bit', source: 'telegram' });
		getDatabase().prepare('UPDATE assistant_timeline SET created_at = ? WHERE id = ?').run(new Date(clock + 500).toISOString(), secondId);
		// Clopen's quick word for it is a line of the chat, kept.
		await sayLine({ id: `ack:${secondId}`, sessionId, text: 'Switching to 8-bit.', answers: secondId });
		getDatabase().prepare('UPDATE assistant_timeline SET created_at = ? WHERE id = ?').run(new Date(clock + 600).toISOString(), `ack:${secondId}`);
		syncTimelineSession(sessionId);
		say('assistant', [{ type: 'text', text: 'Building it.' }]);
		syncTimelineSession(sessionId);
		say('user', [{ type: 'text', text: 'Make it 8-bit' }], {}, secondId);
		say('assistant', [{ type: 'text', text: 'Now in 8-bit.' }]);
		syncTimelineSession(sessionId);
		syncTimelineSession(sessionId);

		const mine = new Set([firstId, secondId, `ack:${secondId}`, `answer:${firstId}`, `answer:${secondId}`]);
		const ids = timeline().entries.map((entry) => entry.id);
		const shown = timeline()
			.entries.filter((entry) => mine.has(entry.id))
			.map((entry) => `${entry.from}: ${entry.text}`);
		expect(shown).toEqual(['owner: Make a retro notes app', 'owner: Make it 8-bit', 'clopen: Switching to 8-bit.', 'clopen: Building it.', 'clopen: Now in 8-bit.']);
		expect(ids).toContain(`answer:${firstId}`);
		expect(ids).toContain(`answer:${secondId}`);
		expect(ids.filter((id) => id === `ack:${secondId}`)).toHaveLength(1);

		// Said once: the same quick word again changes nothing.
		await sayLine({ id: `ack:${secondId}`, sessionId, text: 'Again.', answers: secondId });
		expect(timeline().entries.filter((entry) => entry.id === `ack:${secondId}`).map((entry) => entry.text)).toEqual(['Switching to 8-bit.']);
	});
});
