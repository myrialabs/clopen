import { describe, expect, test } from 'bun:test';
import { extractAiEdits } from './ai-edits-from-messages';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';

// Minimal message shapes — extractToolUses/extractToolResults only read
// `type`, `id`/`toolUseId`, `name`, `input`, and `isError`.
const editMsg = (id: string, filePath: string, oldString: string, newString: string) =>
	({ type: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { filePath, oldString, newString } }] }) as unknown as FrontendMessage;

const writeMsg = (id: string, filePath: string, content: string) =>
	({ type: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { filePath, content } }] }) as unknown as FrontendMessage;

const resultMsg = (toolUseId: string, isError = false) =>
	({ type: 'user', content: [{ type: 'tool_result', toolUseId, isError, content: '' }] }) as unknown as FrontendMessage;

/** A genuine user prompt — this is what opens a new turn (checkpoint). */
const promptMsg = (messageId: string, text = 'do the thing') =>
	({ type: 'user', messageId, synthetic: false, parent: { toolUseId: null }, content: [{ type: 'text', text }] }) as unknown as FrontendMessage;

describe('extractAiEdits', () => {
	test('extracts a successful Edit', () => {
		const out = extractAiEdits([editMsg('e1', '/p/a.ts', 'x', 'y'), resultMsg('e1')]);
		expect(out).toEqual([
			{
				filePath: '/p/a.ts',
				oldContent: 'x',
				newContent: 'y',
				key: 'e1',
				turnIndex: -1,
				checkpointMessageId: null,
				wholeFile: false
			}
		]);
	});

	test('extracts a successful Write as a whole-file entry', () => {
		const out = extractAiEdits([writeMsg('w1', '/p/b.ts', 'hello'), resultMsg('w1')]);
		expect(out).toEqual([
			{
				filePath: '/p/b.ts',
				oldContent: '',
				newContent: 'hello',
				key: 'w1',
				turnIndex: -1,
				checkpointMessageId: null,
				wholeFile: true
			}
		]);
	});

	test('skips edits with no result (in-flight)', () => {
		expect(extractAiEdits([editMsg('e1', '/p/a.ts', 'x', 'y')])).toEqual([]);
	});

	test('skips edits whose result errored', () => {
		expect(extractAiEdits([editMsg('e1', '/p/a.ts', 'x', 'y'), resultMsg('e1', true)])).toEqual([]);
	});

	test('skips Write with empty content', () => {
		expect(extractAiEdits([writeMsg('w1', '/p/b.ts', ''), resultMsg('w1')])).toEqual([]);
	});

	test('preserves conversation order across files', () => {
		const out = extractAiEdits([
			editMsg('e1', '/p/a.ts', '1', '2'),
			resultMsg('e1'),
			writeMsg('w1', '/p/b.ts', 'z'),
			resultMsg('w1'),
			editMsg('e2', '/p/a.ts', '2', '3'),
			resultMsg('e2')
		]);
		expect(out.map((e) => e.key)).toEqual(['e1', 'w1', 'e2']);
	});

	test('ignores non-Edit/Write tools', () => {
		const bash = { type: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } as unknown as FrontendMessage;
		expect(extractAiEdits([bash, resultMsg('b1')])).toEqual([]);
	});

	test('groups edits by the turn they ran in', () => {
		const out = extractAiEdits([
			promptMsg('m1'),
			editMsg('e1', '/p/a.ts', '1', '2'),
			resultMsg('e1'),
			editMsg('e2', '/p/a.ts', '2', '3'),
			resultMsg('e2'),
			promptMsg('m2'),
			editMsg('e3', '/p/a.ts', '3', '4'),
			resultMsg('e3')
		]);
		expect(out.map((e) => [e.key, e.turnIndex, e.checkpointMessageId])).toEqual([
			['e1', 0, 'm1'],
			['e2', 0, 'm1'],
			['e3', 1, 'm2']
		]);
	});

	test('tool-result and synthetic user messages do not open a turn', () => {
		const synthetic = {
			type: 'user',
			messageId: 'm2',
			synthetic: true,
			parent: { toolUseId: null },
			content: [{ type: 'text', text: 'compacted summary' }]
		} as unknown as FrontendMessage;

		const out = extractAiEdits([
			promptMsg('m1'),
			editMsg('e1', '/p/a.ts', '1', '2'),
			resultMsg('e1'),
			synthetic,
			editMsg('e2', '/p/a.ts', '2', '3'),
			resultMsg('e2')
		]);
		expect(out.map((e) => e.turnIndex)).toEqual([0, 0]);
	});

	test('edits before the first visible prompt fall outside any turn', () => {
		// Happens when the loaded message window starts mid-turn (pagination).
		const out = extractAiEdits([editMsg('e1', '/p/a.ts', '1', '2'), resultMsg('e1')]);
		expect(out[0].turnIndex).toBe(-1);
		expect(out[0].checkpointMessageId).toBeNull();
	});
});
