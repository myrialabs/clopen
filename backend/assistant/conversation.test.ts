/**
 * Routing in Clopen's chat — a message stays in the chat it was typed in.
 *
 * Clopen used to guess "a new topic" from the words and split the chat, which
 * broke replies ("no, send it to Notion instead") off from what they
 * answered. Now only a session that grew too long hands over, quietly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { sessionQueries } from '$backend/database/queries';
import { ensureAssistantProject } from './project';
import { routeAssistantMessage } from './conversation';

let sessionId = '';

beforeAll(async () => {
	await initializeDatabase();
	const project = ensureAssistantProject();
	sessionId = sessionQueries.create({ project_id: project.id, title: 'Post Lorem Ipsum on Threads and X', started_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	closeDatabase();
});

describe('routeAssistantMessage', () => {
	it('keeps replies and changes of mind in the same chat, short or long', () => {
		for (const text of ['ya', 'Tidak jadi, kirimkan ke Notion aja', 'Plan a three-day trip to Bali on a small budget with flights and hotels']) {
			expect(routeAssistantMessage({ sessionId, text })).toEqual({ sessionId, changed: false, reason: 'continue' });
		}
	});

	it('starts fresh only when there is no chat yet', () => {
		expect(routeAssistantMessage({ sessionId: null, text: 'halo' }).reason).toBe('fresh');
	});
});
