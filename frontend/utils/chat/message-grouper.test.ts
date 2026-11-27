import { describe, test, expect } from 'bun:test';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import { groupMessages, embedToolResults, getReasoningDuration } from './message-grouper';

const parent = (toolUseId: string | null) => ({ messageId: null, sessionId: null, toolUseId });

function message(type: string, toolUseId: string | null, fields: Record<string, unknown>): FrontendMessage {
	return { type, createdAt: '', messageId: crypto.randomUUID(), sessionId: 's', parent: parent(toolUseId), ...fields } as unknown as FrontendMessage;
}

describe('sub-agent reasoning', () => {
	test('folds into its Agent tool and never renders at the root', () => {
		const messages = [
			message('reasoning', null, { text: 'root thinking' }),
			message('assistant', null, {
				content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'explore' }, result: null, subActivities: [], skillPrompt: null, interrupted: false }],
			}),
			message('reasoning', 'agent-1', { text: 'child thinking' }),
			message('assistant', 'agent-1', {
				content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { filePath: 'a.ts' }, result: null, subActivities: [], skillPrompt: null, interrupted: false }],
			}),
		];

		const { groups, toolUseMap, subAgentMap, skillPromptMap } = groupMessages(messages);
		const rootReasoning = groups.filter(m => m.type === 'reasoning');
		expect(rootReasoning.map(m => 'text' in m && m.text)).toEqual(['root thinking']);

		const embedded = embedToolResults(groups, toolUseMap, subAgentMap, skillPromptMap);
		const agent = embedded.find(m => m.type === 'assistant') as { content: Array<{ subActivities: unknown[] }> };
		expect(agent.content[0].subActivities).toMatchObject([
			{ type: 'reasoning', text: 'child thinking' },
			{ type: 'tool_use', name: 'Read' },
		]);
	});
});

describe('durations', () => {
	const at = (seconds: number) => new Date(Date.UTC(2026, 10, 27, 12, 0, seconds)).toISOString();
	const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
		({ type: 'tool_use', id, name, input, result: null, subActivities: [], skillPrompt: null, interrupted: false });

	test('a tool call lasts from the message that made it to the one that answered it', () => {
		const messages = [
			{ ...message('assistant', null, { content: [toolUse('bash-1', 'Bash', { command: 'ls' })] }), createdAt: at(0) },
			{ ...message('user', null, { content: [{ type: 'tool_result', toolUseId: 'bash-1', content: 'a.ts', isError: false }] }), createdAt: at(3) },
		] as FrontendMessage[];

		const { groups, toolUseMap, subAgentMap, skillPromptMap } = groupMessages(messages);
		const [assistant] = embedToolResults(groups, toolUseMap, subAgentMap, skillPromptMap) as Array<{ content: Array<{ durationMs?: number }> }>;
		expect(assistant.content[0].durationMs).toBe(3000);
	});

	test('a call still running or launched into the background has none', () => {
		const messages = [
			{ ...message('assistant', null, { content: [toolUse('bash-1', 'Bash', { command: 'serve', runInBackground: true }), toolUse('read-1', 'Read')] }), createdAt: at(0) },
			{ ...message('user', null, { content: [{ type: 'tool_result', toolUseId: 'bash-1', content: 'Command running in background with ID: b1', isError: false }] }), createdAt: at(1) },
		] as FrontendMessage[];

		const { groups, toolUseMap, subAgentMap, skillPromptMap } = groupMessages(messages);
		const [assistant] = embedToolResults(groups, toolUseMap, subAgentMap, skillPromptMap) as Array<{ content: Array<{ durationMs?: number }> }>;
		expect(assistant.content.map((block) => block.durationMs)).toEqual([undefined, undefined]);
	});

	test('reasoning lasts from the message before it, ignoring sub-agents running alongside', () => {
		const prompt = { ...message('user', null, { content: [{ type: 'text', text: 'go' }] }), createdAt: at(0) };
		const child = { ...message('reasoning', 'agent-1', { text: 'child' }), createdAt: at(9) };
		const thought = { ...message('reasoning', null, { text: 'root' }), createdAt: at(12) };
		const { groups } = groupMessages([prompt, child, thought] as FrontendMessage[]);

		const reasoning = groups.find((m) => m.type === 'reasoning')!;
		expect(getReasoningDuration(reasoning)).toBe(12_000);
	});

	test('the first message loaded has no known start, and a skewed clock gives no duration', () => {
		const first = { ...message('reasoning', null, { text: 'a' }), createdAt: at(5) };
		const skewed = { ...message('reasoning', null, { text: 'b' }), createdAt: at(1) };
		const { groups } = groupMessages([first, skewed] as FrontendMessage[]);

		expect(groups.map((m) => getReasoningDuration(m))).toEqual([undefined, undefined]);
	});
});
