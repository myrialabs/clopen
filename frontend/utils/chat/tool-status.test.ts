import { describe, it, expect } from 'bun:test';
import type { ToolUseBlock } from '$shared/types/unified';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import { combineToolStatuses, getToolStatus, isInCurrentTurn } from './tool-status';

function call(id: string, fields: Partial<ToolUseBlock> = {}): ToolUseBlock {
	return { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' }, result: null, subActivities: [], skillPrompt: null, interrupted: false, ...fields } as ToolUseBlock;
}

const prompt = (text: string) => ({ type: 'user', content: [{ type: 'text', text }] }) as unknown as FrontendMessage;
const made = (...ids: string[]) => ({ type: 'assistant', content: ids.map((id) => call(id)) }) as unknown as FrontendMessage;
const answered = (id: string) => ({ type: 'user', content: [{ type: 'tool_result', toolUseId: id, content: '', isError: false }] }) as unknown as FrontendMessage;

// An earlier turn left `old` unanswered; the current turn has made `a` and `b`.
const messages = [prompt('first'), made('old'), prompt('second'), made('a'), answered('a'), made('b')];

describe('getToolStatus', () => {
	it('settles a call by its result', () => {
		const live = { isLoading: true, isWaitingInput: false, messages };
		expect(getToolStatus(call('a', { result: { type: 'tool_result', toolUseId: 'a', content: '', isError: false } }), live)).toBe('success');
		expect(getToolStatus(call('a', { result: { type: 'tool_result', toolUseId: 'a', content: 'boom', isError: true } }), live)).toBe('error');
	});

	it('runs only while the session runs and the call belongs to the current turn', () => {
		expect(getToolStatus(call('b'), { isLoading: true, isWaitingInput: false, messages })).toBe('processing');
		expect(getToolStatus(call('b'), { isLoading: true, isWaitingInput: true, messages })).toBe('waiting');
		expect(getToolStatus(call('b'), { isLoading: false, isWaitingInput: false, messages })).toBe('interrupted');
	});

	it('does not spin an unanswered call from an earlier turn when a new turn starts', () => {
		expect(getToolStatus(call('old'), { isLoading: true, isWaitingInput: false, messages })).toBe('interrupted');
	});

	it('honours a call already marked interrupted', () => {
		expect(getToolStatus(call('b', { interrupted: true }), { isLoading: true, isWaitingInput: false, messages })).toBe('interrupted');
	});
});

describe('isInCurrentTurn', () => {
	it('looks back past tool results and engine notices, stopping at the last real prompt', () => {
		const notice = { type: 'user', synthetic: true, content: [{ type: 'text', text: 'note' }] } as unknown as FrontendMessage;
		expect(isInCurrentTurn([...messages, notice], 'a')).toBe(true);
		expect(isInCurrentTurn(messages, 'old')).toBe(false);
	});
});

describe('combineToolStatuses', () => {
	it('lets anything unsettled win, then any failure', () => {
		expect(combineToolStatuses([])).toBeNull();
		expect(combineToolStatuses(['success', 'processing', 'error'])).toBe('processing');
		expect(combineToolStatuses(['success', 'waiting'])).toBe('waiting');
		expect(combineToolStatuses(['success', 'interrupted', 'error'])).toBe('error');
		expect(combineToolStatuses(['success', 'interrupted'])).toBe('interrupted');
		expect(combineToolStatuses(['success', 'success'])).toBe('success');
	});
});
