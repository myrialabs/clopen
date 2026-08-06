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
