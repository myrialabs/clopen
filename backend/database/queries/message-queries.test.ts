/**
 * A sent message is saved under the id its optimistic bubble already shows,
 * when that id is safe to take; and which messages count as on a session's
 * active branch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { initializeDatabase, closeDatabase } from '$backend/database';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';

let projectId: string;

const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
const user = (text: string, messageId = '') => ({
	type: 'user',
	createdAt: '',
	messageId,
	sessionId: null,
	parent: { messageId: null, sessionId: null, toolUseId: null },
	engine,
	content: [{ type: 'text', text }]
}) as unknown as UnifiedMessage;

function newSession(): string {
	return sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: new Date().toISOString() } as never).id;
}

/** Append to a session's branch, moving HEAD like the stream does. */
function append(sessionId: string, text: string, parent?: string): string {
	const row = messageQueries.create({ session_id: sessionId, message: user(text), parent_message_id: parent });
	sessionQueries.updateHead(sessionId, row.id);
	return row.id;
}

beforeAll(async () => {
	await initializeDatabase();
	projectId = projectQueries.create({ name: 'message-queries', path: `/tmp/message-queries-${crypto.randomUUID()}`, created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	sessionQueries.deleteAllByProjectId(projectId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('messageQueries.create preferred_id', () => {
	it('keeps a fresh UUID, in the row and in the stored message alike', () => {
		const session = newSession();
		const id = crypto.randomUUID();
		const row = messageQueries.create({ session_id: session, message: user('hi', id), preferred_id: id });
		expect(row.id).toBe(id);
		expect(JSON.parse(row.data).messageId).toBe(id);
		expect(messageQueries.getById(id)?.session_id).toBe(session);
	});

	it('accepts an upper-case UUID as is', () => {
		const id = crypto.randomUUID().toUpperCase();
		const row = messageQueries.create({ session_id: newSession(), message: user('hi'), preferred_id: id });
		expect(row.id).toBe(id);
	});

	it('never takes an id that is already saved — not even from another session', () => {
		const id = crypto.randomUUID();
		messageQueries.create({ session_id: newSession(), message: user('first'), preferred_id: id });
		const second = messageQueries.create({ session_id: newSession(), message: user('second'), preferred_id: id });
		expect(second.id).not.toBe(id);
		expect(JSON.parse(messageQueries.getById(id)!.data).content[0].text).toBe('first');
	});

	it('gives a fresh id to anything that is not a canonical UUID', () => {
		const session = newSession();
		const uuid = crypto.randomUUID();
		const hostile: unknown[] = [
			'',
			' ',
			'abc',
			`${uuid} `,
			` ${uuid}`,
			`${uuid}\n`,
			`${uuid}x`,
			uuid.replace(/-/g, ''),
			`{${uuid}}`,
			`${uuid}'; DROP TABLE messages; --`,
			"' OR 1=1 --",
			'../../etc/passwd',
			'00000000-0000-0000-0000-00000000000g',
			'a'.repeat(10_000),
			'💥💥💥💥💥💥💥💥-💥💥💥💥-💥💥💥💥-💥💥💥💥-💥💥💥💥💥💥💥💥💥💥💥💥',
			null,
			42,
			{ toString: () => crypto.randomUUID() },
			[crypto.randomUUID()]
		];
		for (const preferred of hostile) {
			const row = messageQueries.create({ session_id: session, message: user('x'), preferred_id: preferred as string });
			expect(row.id).not.toBe(preferred as string);
			expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		}
		expect(messageQueries.getById(uuid)).toBeNull();
	});

	it('gives a fresh id when none is asked for', () => {
		const a = messageQueries.create({ session_id: newSession(), message: user('a') });
		const b = messageQueries.create({ session_id: newSession(), message: user('b') });
		expect(a.id).not.toBe(b.id);
	});
});

describe('messageQueries.isOnActivePath', () => {
	it('is true for HEAD and every ancestor of it', () => {
		const session = newSession();
		const one = append(session, 'one');
		const two = append(session, 'two', one);
		const three = append(session, 'three', two);
		for (const id of [one, two, three]) expect(messageQueries.isOnActivePath(session, id)).toBe(true);
	});

	it('is false for a branch the session moved away from', () => {
		const session = newSession();
		const one = append(session, 'one');
		const abandoned = append(session, 'abandoned', one);
		const taken = append(session, 'taken', one);
		expect(messageQueries.isOnActivePath(session, abandoned)).toBe(false);
		expect(messageQueries.isOnActivePath(session, taken)).toBe(true);
	});

	it('is false after rewinding before the message', () => {
		const session = newSession();
		const one = append(session, 'one');
		const two = append(session, 'two', one);
		sessionQueries.updateHead(session, one);
		expect(messageQueries.isOnActivePath(session, two)).toBe(false);
	});

	it('is false for another session’s message, an unknown id, and a session without HEAD', () => {
		const session = newSession();
		append(session, 'mine');
		const other = newSession();
		const theirs = append(other, 'theirs');
		expect(messageQueries.isOnActivePath(session, theirs)).toBe(false);
		expect(messageQueries.isOnActivePath(session, crypto.randomUUID())).toBe(false);
		expect(messageQueries.isOnActivePath(newSession(), theirs)).toBe(false);
		expect(messageQueries.isOnActivePath(crypto.randomUUID(), theirs)).toBe(false);
	});
});
