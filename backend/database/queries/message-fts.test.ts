/**
 * The messages_fts index stays in step with messages through every write and
 * delete path, and every delete finds its rows through messages_fts_map
 * (by rowid) instead of scanning the index for a message id.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '$backend/database';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';

let projectId: string;

const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
const user = (text: string) => ({
	type: 'user',
	createdAt: '',
	messageId: '',
	sessionId: null,
	parent: { messageId: null, sessionId: null, toolUseId: null },
	engine,
	content: [{ type: 'text', text }]
}) as unknown as UnifiedMessage;

function newSession(): string {
	return sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: new Date().toISOString() } as never).id;
}

function save(sessionId: string, text: string, timestamp?: string): string {
	return messageQueries.create({ session_id: sessionId, message: user(text), timestamp }).id;
}

/** FTS rows and map rows of a session, plus whether they point at each other. */
function indexOf(sessionId: string) {
	const db = getDatabase();
	const fts = db.prepare('SELECT rowid, message_id FROM messages_fts WHERE session_id = ?').all(sessionId) as { rowid: number; message_id: string }[];
	const map = db.prepare('SELECT message_id, fts_rowid FROM messages_fts_map WHERE session_id = ?').all(sessionId) as { message_id: string; fts_rowid: number }[];
	const consistent = fts.length === map.length && map.every((m) => fts.some((f) => f.rowid === m.fts_rowid && f.message_id === m.message_id));
	return { fts, map, consistent };
}

beforeAll(async () => {
	await initializeDatabase();
	projectId = projectQueries.create({ name: 'message-fts', path: `/tmp/message-fts-${crypto.randomUUID()}`, created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	sessionQueries.deleteAllByProjectId(projectId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('messages_fts through messages_fts_map', () => {
	it('indexes a saved message and maps it to its FTS row', () => {
		const session = newSession();
		const id = save(session, 'quokka sunrise');
		const { fts, map, consistent } = indexOf(session);
		expect(fts.map((r) => r.message_id)).toEqual([id]);
		expect(map.map((r) => r.message_id)).toEqual([id]);
		expect(consistent).toBe(true);
		expect(sessionQueries.searchByMessageContent(projectId, 'quokka').map((r) => r.sessionId)).toContain(session);
	});

	it('leaves no FTS or map row for a message without searchable text', () => {
		const session = newSession();
		save(session, '   ');
		expect(indexOf(session).fts).toHaveLength(0);
		expect(indexOf(session).map).toHaveLength(0);
	});

	it('removes exactly the deleted message', () => {
		const session = newSession();
		const keep = save(session, 'keep this one');
		const drop = save(session, 'drop this one');
		messageQueries.delete(drop);
		const { fts, consistent } = indexOf(session);
		expect(fts.map((r) => r.message_id)).toEqual([keep]);
		expect(consistent).toBe(true);
	});

	it('removes messages cut by deleteAfterTimestamp', () => {
		const session = newSession();
		const early = save(session, 'early message', '2026-01-01T00:00:00.000Z');
		save(session, 'late message one', '2026-01-02T00:00:00.000Z');
		save(session, 'late message two', '2026-01-03T00:00:00.000Z');
		messageQueries.deleteAfterTimestamp(session, '2026-01-02T00:00:00.000Z');
		const { fts, consistent } = indexOf(session);
		expect(fts.map((r) => r.message_id)).toEqual([early]);
		expect(consistent).toBe(true);
	});

	it('removes a whole session, through either delete path', () => {
		const a = newSession();
		const b = newSession();
		save(a, 'session a text');
		save(b, 'session b text');
		messageQueries.deleteBySessionId(a);
		sessionQueries.delete(b);
		expect(indexOf(a).fts).toHaveLength(0);
		expect(indexOf(a).map).toHaveLength(0);
		expect(indexOf(b).fts).toHaveLength(0);
		expect(indexOf(b).map).toHaveLength(0);
	});

	it('removes every session of a deleted project, and only those', async () => {
		const otherProject = projectQueries.create({ name: 'message-fts-other', path: `/tmp/message-fts-other-${crypto.randomUUID()}`, created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
		const other = sessionQueries.create({ project_id: otherProject, engine: 'claude-code', started_at: new Date().toISOString() } as never).id;
		const mine = newSession();
		save(other, 'other project text');
		save(mine, 'my project text');

		sessionQueries.deleteAllByProjectId(otherProject);
		projectQueries.deleteProject(otherProject);

		expect(indexOf(other).fts).toHaveLength(0);
		expect(indexOf(other).map).toHaveLength(0);
		expect(indexOf(mine).fts).toHaveLength(1);
		expect(indexOf(mine).consistent).toBe(true);
	});
});
