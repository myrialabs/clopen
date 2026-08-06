import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowTranscriptTailer } from './workflow-transcript';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('WorkflowTranscriptTailer', () => {
	test('replays each appended child tool call and result exactly once', async () => {
		const root = await mkdtemp(join(tmpdir(), 'clopen-workflow-'));
		temporaryDirectories.push(root);
		const sessionDirectory = join(root, 'session');
		const directory = join(sessionDirectory, 'subagents', 'workflows', 'workflow-run-1');
		await mkdir(directory, { recursive: true });
		await mkdir(join(sessionDirectory, 'workflows'), { recursive: true });
		const transcript = join(directory, 'agent-a1.jsonl');
		await Bun.write(transcript,
			JSON.stringify({ type: 'assistant', uuid: 'assistant-1', timestamp: '2026-01-01T00:00:01Z', message: { model: 'claude', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } }) + '\n'
		);

		const launch = {
			type: 'user', session_id: 'session-1', uuid: 'launch-1', parent_tool_use_id: null,
			message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'workflow-1', content: `Workflow launched in background. Task ID: task-1\nTranscript dir: ${directory}\nRun ID: workflow-run-1` }] },
		} as any;
		const tailer = new WorkflowTranscriptTailer();
		tailer.observe({
			type: 'assistant', session_id: 'session-1', uuid: 'workflow-use', parent_tool_use_id: null,
			message: { model: 'claude', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'workflow-1', name: 'Workflow', input: { script: '' } }] },
		} as any);
		tailer.observe(launch);
		const first = await tailer.drain();
		const changeVersion = tailer.changeVersion;
		const changed = tailer.waitForChange(changeVersion, new AbortController().signal);
		await appendFile(transcript,
			JSON.stringify({ type: 'user', uuid: 'user-1', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file contents' }] } }) + '\n'
		);
		await changed;
		const second = await tailer.drain();
		const third = await tailer.drain();
		expect(await tailer.hasActiveWorkflows()).toBe(true);
		const statusVersion = tailer.changeVersion;
		const statusChanged = tailer.waitForChange(statusVersion, new AbortController().signal);
		await Bun.write(join(sessionDirectory, 'workflows', 'workflow-run-1.json'), JSON.stringify({ status: 'completed' }));
		await statusChanged;
		expect(await tailer.hasActiveWorkflows()).toBe(false);

		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			type: 'assistant', createdAt: '2026-01-01T00:00:01Z', parent: { toolUseId: 'workflow-1' },
			content: [{ type: 'tool_use', id: 'read-1', name: 'Read' }],
		});
		expect(second).toHaveLength(1);
		expect(second[0]).toMatchObject({
			type: 'user', createdAt: '2026-01-01T00:00:02Z', parent: { toolUseId: 'workflow-1' },
			content: [{ type: 'tool_result', toolUseId: 'read-1', content: 'file contents' }],
		});
		expect(third).toEqual([]);
		tailer.dispose();
	});
});
