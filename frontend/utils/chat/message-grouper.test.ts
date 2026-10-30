import { describe, test, expect } from 'bun:test';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import { groupMessages, embedToolResults } from './message-grouper';

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
