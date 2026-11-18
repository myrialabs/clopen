/**
 * Paging a chat's active branch: pages start at a turn so no turn is split,
 * consecutive pages cover the branch exactly once, and the prompt index and
 * task history cover what is not loaded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { initializeDatabase, closeDatabase } from '$backend/database';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';

import { getMessagePage, getPromptIndex, getTaskHistory } from './message-pages';

let projectId: string;
const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
const base = { createdAt: '2026-11-17T00:00:00.000Z', sessionId: null, engine };

const prompt = (text: string) =>
	({ ...base, type: 'user', parent: { messageId: null, sessionId: null, toolUseId: null }, content: [{ type: 'text', text }] }) as unknown as UnifiedMessage;
const toolCall = (id: string, name = 'Read', input: unknown = {}) =>
	({ ...base, type: 'assistant', parent: { messageId: null, sessionId: null, toolUseId: null }, content: [{ type: 'tool_use', id, name, input }] }) as unknown as UnifiedMessage;
const toolResult = (toolUseId: string, content = 'ok') =>
	({ ...base, type: 'user', parent: { messageId: null, sessionId: null, toolUseId: null }, content: [{ type: 'tool_result', toolUseId, content }] }) as unknown as UnifiedMessage;
const answer = (text: string) =>
	({ ...base, type: 'assistant', parent: { messageId: null, sessionId: null, toolUseId: null }, content: [{ type: 'text', text }] }) as unknown as UnifiedMessage;

function newSession(): string {
	return sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: new Date().toISOString() } as never).id;
}

/** Build a branch of turns: each turn = prompt, N tool call/result pairs, answer. */
function buildBranch(sessionId: string, turns: number, toolsPerTurn: number): string[] {
	const ids: string[] = [];
	let parent: string | undefined;
	const push = (message: UnifiedMessage) => {
		const row = messageQueries.create({ session_id: sessionId, message, parent_message_id: parent });
		parent = row.id;
		ids.push(row.id);
		sessionQueries.updateHead(sessionId, row.id);
	};
	for (let t = 0; t < turns; t++) {
		push(prompt(`turn ${t}`));
		for (let k = 0; k < toolsPerTurn; k++) {
			push(toolCall(`call-${t}-${k}`));
			push(toolResult(`call-${t}-${k}`));
		}
		push(answer(`done ${t}`));
	}
	return ids;
}

const textOf = (message: UnifiedMessage) =>
	message.type === 'user' || message.type === 'assistant'
		? (message.content.find((block) => block.type === 'text') as { text?: string } | undefined)?.text
		: undefined;

beforeAll(async () => {
	await initializeDatabase();
	projectId = projectQueries.create({ name: 'message-pages', path: `/tmp/message-pages-${crypto.randomUUID()}`, created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	sessionQueries.deleteAllByProjectId(projectId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('getMessagePage', () => {
	it('never splits a tool call from its result, even inside a long turn', () => {
		const session = newSession();
		buildBranch(session, 2, 60); // two turns of 122 messages each

		const page = getMessagePage(session, { minCount: 10 });
		expect(page.messages.length).toBeLessThan(20); // cut inside the turn, not at its start
		expect(page.hasMore).toBe(true);
		const calls = new Set<string>();
		for (const message of page.messages) {
			if (message.type !== 'user' && message.type !== 'assistant') continue;
			for (const block of message.content) {
				if (block.type === 'tool_use') calls.add(block.id);
				if (block.type === 'tool_result') expect(calls.has((block as { toolUseId: string }).toolUseId)).toBe(true);
			}
		}
	});

	it('does not begin a page with a synthetic message, nor split a sub-agent from its call', () => {
		const session = newSession();
		let parent: string | undefined;
		const push = (message: UnifiedMessage) => {
			const row = messageQueries.create({ session_id: session, message, parent_message_id: parent });
			parent = row.id;
			sessionQueries.updateHead(session, row.id);
		};
		push(prompt('start'));
		push(toolCall('agent-1', 'Agent'));
		push({ ...(prompt('sub-agent work') as object), parent: { messageId: null, sessionId: null, toolUseId: 'agent-1' } } as unknown as UnifiedMessage);
		push({ ...(answer('sub-agent answer') as object), parent: { messageId: null, sessionId: null, toolUseId: 'agent-1' } } as unknown as UnifiedMessage);
		push(toolResult('agent-1'));
		push(toolCall('skill-1', 'Skill'));
		push({ ...(prompt('expanded skill prompt') as object), synthetic: true } as unknown as UnifiedMessage);

		const page = getMessagePage(session, { minCount: 1 });
		expect((page.messages[0] as { synthetic?: boolean }).synthetic).not.toBe(true);
		const texts = page.messages.map(textOf);
		if (texts.includes('sub-agent work')) expect(page.messages.some((m) => JSON.stringify(m).includes('"id":"agent-1"'))).toBe(true);
	});

	it('pages back through the whole branch exactly once, in order', () => {
		const session = newSession();
		const ids = buildBranch(session, 12, 2);

		const collected: string[] = [];
		let before: string | undefined;
		for (let guard = 0; guard < 50; guard++) {
			const page = getMessagePage(session, { beforeId: before, minCount: 7 });
			collected.unshift(...page.messages.map((message) => (message as { messageId: string }).messageId));
			if (!page.hasMore) break;
			before = (page.messages[0] as { messageId: string }).messageId;
		}
		expect(collected).toEqual(ids);
	});

	it('reaches back to a requested message in one page, contiguous with the loaded ones', () => {
		const session = newSession();
		const ids = buildBranch(session, 12, 2); // 6 messages per turn

		const latest = getMessagePage(session, { minCount: 7 });
		const before = (latest.messages[0] as { messageId: string }).messageId;
		const target = ids[7]; // inside turn 1, far older than one page
		const page = getMessagePage(session, { beforeId: before, minCount: 7, untilId: target });
		const pageIds = page.messages.map((message) => (message as { messageId: string }).messageId);

		expect(pageIds).toContain(target);
		const start = ids.indexOf(pageIds[0]);
		expect(start).toBeLessThanOrEqual(7);
		expect([...pageIds, ...latest.messages.map((m) => (m as { messageId: string }).messageId)]).toEqual(ids.slice(start));
		expect(page.hasMore).toBe(true);
	});

	it('answers an empty page for a session with no messages, or an unknown cursor', () => {
		const session = newSession();
		expect(getMessagePage(session)).toEqual({ messages: [], hasMore: false });
		buildBranch(session, 1, 0);
		expect(getMessagePage(session, { beforeId: 'not-a-message' })).toEqual({ messages: [], hasMore: false });
	});
});

describe('getPromptIndex', () => {
	it('lists every real prompt on the branch, oldest first, with no tool results', () => {
		const session = newSession();
		buildBranch(session, 4, 2);
		expect(getPromptIndex(session).map((entry) => entry.text)).toEqual(['turn 0', 'turn 1', 'turn 2', 'turn 3']);
	});
});

describe('getTaskHistory', () => {
	it('returns the task calls and their results older than a message, and nothing else', () => {
		const session = newSession();
		let parent: string | undefined;
		const push = (message: UnifiedMessage) => {
			const row = messageQueries.create({ session_id: session, message, parent_message_id: parent });
			parent = row.id;
			sessionQueries.updateHead(session, row.id);
			return row.id;
		};
		push(prompt('plan'));
		push(toolCall('task-1', 'TaskCreate', { subject: 'Write tests' }));
		push(toolResult('task-1', 'Task #1 created'));
		push(toolCall('read-1', 'Read'));
		push(toolResult('read-1', 'file body'));
		const later = push(prompt('next'));
		push(toolCall('task-2', 'TaskUpdate', { taskId: '1', status: 'completed' }));

		const history = getTaskHistory(session, later);
		expect(history.map((message) => message.type)).toEqual(['assistant', 'user']);
		expect(JSON.stringify(history)).toContain('task-1');
		expect(JSON.stringify(history)).not.toContain('read-1');
		expect(JSON.stringify(history)).not.toContain('task-2'); // newer than the cursor
	});
});
