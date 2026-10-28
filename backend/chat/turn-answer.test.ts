/**
 * What a turn's "answer" is, read back from the stored chain: the last text,
 * the failure apart from it, and a turn that opened with only a photo.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { initializeDatabase, closeDatabase } from '$backend/database';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';
import { lastTurnAnswer } from './turn-answer';

let projectId: string;

function chain(sessionId: string, messages: UnifiedMessage[]): string[] {
	const ids: string[] = [];
	let parent: string | undefined;
	for (const message of messages) {
		const row = messageQueries.create({ session_id: sessionId, message, parent_message_id: parent });
		parent = row.id;
		ids.push(row.id);
		sessionQueries.updateHead(sessionId, row.id);
	}
	return ids;
}

const base = { createdAt: '', messageId: '', sessionId: null, parent: { messageId: null, sessionId: null, toolUseId: null } };
const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
const user = (content: unknown[]) => ({ ...base, type: 'user', engine, content }) as unknown as UnifiedMessage;
const assistant = (text: string) => ({ ...base, type: 'assistant', engine, content: [{ type: 'text', text }], stopReason: null, usage: null }) as unknown as UnifiedMessage;

function newSession(): string {
	return sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: new Date().toISOString() } as never).id;
}

beforeAll(async () => {
	await initializeDatabase();
	projectId = projectQueries.create({ name: 'turn-answer', path: `/tmp/turn-answer-${crypto.randomUUID()}`, created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	sessionQueries.deleteAllByProjectId(projectId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('lastTurnAnswer', () => {
	it('is the last text of the turn, with the turn’s own user message', () => {
		const session = newSession();
		const [, , ask] = chain(session, [user([{ type: 'text', text: 'one' }]), assistant('first'), user([{ type: 'text', text: 'two' }]), assistant('looking…'), assistant('second')]);
		expect(lastTurnAnswer(session)).toMatchObject({ text: 'second', error: null, userMessageId: ask });
	});

	it('keeps a failure apart from what the turn said before it', () => {
		const session = newSession();
		chain(session, [user([{ type: 'text', text: 'do it' }]), assistant('half done'), assistant('**Error:** rate limited')]);
		expect(lastTurnAnswer(session)).toMatchObject({ text: 'half done', error: 'rate limited' });
	});

	it('stops at a turn that opened with only a photo, never reaching the turn before', () => {
		const session = newSession();
		const ids = chain(session, [user([{ type: 'text', text: 'one' }]), assistant('first'), user([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])]);
		expect(lastTurnAnswer(session)).toMatchObject({ text: '', userMessageId: ids[2] });
	});
});
