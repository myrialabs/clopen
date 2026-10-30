import { describe, expect, test } from 'bun:test';
import { createSdkMessageConverter, mapAssistantContent } from './message-converter';

describe('Claude workflow tools', () => {
	test('keeps Workflow and REPL canonical', () => {
		const blocks = mapAssistantContent([
			{ type: 'tool_use', id: 'workflow-1', name: 'Workflow', input: { name: 'audit' } },
			{ type: 'tool_use', id: 'repl-1', name: 'REPL', input: { code: 'return 1' } },
		] as any);

		expect(blocks.map(block => block.type === 'tool_use' ? block.name : block.type)).toEqual(['Workflow', 'REPL']);
	});

	test('threads workflow task lifecycle into the Workflow parent', () => {
		const convert = createSdkMessageConverter();
		const started = [...convert({
			type: 'system', subtype: 'task_started', session_id: 'session-1', uuid: 'started-1',
			task_id: 'task-1', tool_use_id: 'workflow-1', task_type: 'local_workflow',
			workflow_name: 'audit', description: 'Audit repository',
		} as any)];
		const progress = [...convert({
			type: 'system', subtype: 'task_progress', session_id: 'session-1', uuid: 'progress-1',
			task_id: 'task-1', description: 'Audit repository', last_tool_name: 'Read',
			usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
		} as any)];
		const staticHeartbeat = [...convert({
			type: 'system', subtype: 'task_progress', session_id: 'session-1', uuid: 'progress-3',
			task_id: 'task-1', description: 'Audit repository',
			usage: { total_tokens: 3, tool_uses: 2, duration_ms: 3 },
		} as any)];

		expect(started[0]).toMatchObject({ type: 'assistant', parent: { toolUseId: 'workflow-1' } });
		expect(progress).toEqual([]);
		expect(staticHeartbeat).toEqual([]);
	});
});

describe('Claude sub-agent scoping', () => {
	const thinkingMessage = (parentToolUseId: string | null) => ({
		type: 'assistant', session_id: 'session-1', uuid: crypto.randomUUID(), parent_tool_use_id: parentToolUseId,
		message: {
			model: 'claude-test', stop_reason: null, usage: null,
			content: [
				{ type: 'thinking', thinking: 'considering the files' },
				{ type: 'text', text: 'done', citations: null },
			],
		},
	} as any);

	test('keeps a sub-agent\'s thinking inside its Agent tool', () => {
		const outputs = [...createSdkMessageConverter()(thinkingMessage('agent-1'))];
		const reasoning = outputs.find(o => o.type === 'reasoning');
		const assistant = outputs.find(o => o.type === 'assistant');
		expect(reasoning).toMatchObject({ parent: { toolUseId: 'agent-1' }, text: 'considering the files' });
		expect(assistant).toMatchObject({ parent: { toolUseId: 'agent-1' } });
	});

	test('leaves root thinking at the root', () => {
		const outputs = [...createSdkMessageConverter()(thinkingMessage(null))];
		expect(outputs.find(o => o.type === 'reasoning')).toMatchObject({ parent: { toolUseId: null } });
	});

	test('drops a sub-agent\'s live partials without disturbing the root block state', () => {
		const convert = createSdkMessageConverter();
		const partial = (parent: string | null, event: Record<string, unknown>) => ({
			type: 'stream_event', session_id: 'session-1', uuid: crypto.randomUUID(), parent_tool_use_id: parent, event,
		} as any);

		// Root opens a thinking block at index 0.
		[...convert(partial(null, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))];
		// A sub-agent opens and closes a text block at the same index.
		const child = [
			...convert(partial('agent-1', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
			...convert(partial('agent-1', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'child' } })),
			...convert(partial('agent-1', { type: 'content_block_stop', index: 0 })),
		];
		expect(child).toEqual([]);

		// The root's block still closes as reasoning.
		const stop = [...convert(partial(null, { type: 'content_block_stop', index: 0 }))];
		expect(stop).toEqual([{ type: 'stream_event', event: 'stop', sessionId: 'session-1', reasoning: true }]);
	});
});
