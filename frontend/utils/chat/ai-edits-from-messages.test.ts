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

describe('extractAiEdits', () => {
	test('extracts a successful Edit', () => {
		const out = extractAiEdits([editMsg('e1', '/p/a.ts', 'x', 'y'), resultMsg('e1')]);
		expect(out).toEqual([{ filePath: '/p/a.ts', oldContent: 'x', newContent: 'y', key: 'e1' }]);
	});

	test('extracts a successful Write as an empty-old entry', () => {
		const out = extractAiEdits([writeMsg('w1', '/p/b.ts', 'hello'), resultMsg('w1')]);
		expect(out).toEqual([{ filePath: '/p/b.ts', oldContent: '', newContent: 'hello', key: 'w1' }]);
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
});
