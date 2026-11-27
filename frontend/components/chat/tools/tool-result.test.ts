import { describe, it, expect } from 'bun:test';
import type { ToolResult, ToolUseBlock } from '$shared/types/unified';
import { failureText, resultText, withoutFailure } from './tool-result';
import { detailViews } from './variants/compact/components/details';

function call(name: string, input: Record<string, unknown>, result: Partial<ToolResult> | null = null): ToolUseBlock {
	return {
		type: 'tool_use', id: 't1', name, input, subActivities: [], skillPrompt: null, interrupted: false,
		result: result && { type: 'tool_result', toolUseId: 't1', content: '', isError: false, ...result }
	} as ToolUseBlock;
}

describe('failures', () => {
	it('takes a failed result away from the renderer and shows its text instead', () => {
		const failed = call('Edit', { filePath: 'a.ts' }, { content: 'old_string not found', isError: true });
		expect(failureText(failed)).toBe('old_string not found');
		expect(withoutFailure(failed).result).toBeNull();
	});

	it('leaves a successful call, and one whose renderer reads its own failure, untouched', () => {
		const ok = call('Read', { filePath: 'a.ts' }, { content: '1 hello' });
		expect(failureText(ok)).toBeNull();
		expect(withoutFailure(ok)).toBe(ok);

		const unanswered = call('AskUserQuestion', { questions: [] }, { content: 'dismissed', isError: true });
		expect(failureText(unanswered)).toBeNull();
		expect(withoutFailure(unanswered).result).not.toBeNull();
	});

	it('still says something when the engine gave no reason', () => {
		expect(failureText(call('Bash', { command: 'x' }, { content: '  ', isError: true }))).toBe('The tool failed without saying why.');
	});

	it('reads results in whatever shape the engine sent', () => {
		expect(resultText({ content: [{ text: 'a' }, { text: 'b' }] } as unknown as ToolResult)).toBe('a\nb');
		expect(resultText(null)).toBe('');
	});
});

describe('compact details', () => {
	it('shows a file edit as a diff and leaves out its "updated" confirmation', () => {
		const views = detailViews(call('Edit', { filePath: 'a.ts', oldString: 'a', newString: 'b' }, { content: 'The file has been updated.' }));
		expect(views).toEqual([{ kind: 'diff', label: 'Changes', oldString: 'a', newString: 'b' }]);
	});

	it('shows only the output when the row already shows the whole call', () => {
		expect(detailViews(call('Bash', { command: 'ls' }, { content: 'a.ts\n' }))).toEqual([{ kind: 'terminal', label: 'Output', code: 'a.ts' }]);
		expect(detailViews(call('Read', { filePath: 'a.ts' }))).toEqual([]);
	});

	it('shows the arguments of an MCP or unrecognised call', () => {
		const views = detailViews(call('mcp__github__create_issue', { title: 'Bug' }, { content: 'created #1' }));
		expect(views.map((view) => view.label)).toEqual(['Input', 'Output']);
	});

	it('has nothing to open for a call with no arguments and no result yet', () => {
		expect(detailViews(call('mcp__x__ping', {}))).toEqual([]);
	});
});
