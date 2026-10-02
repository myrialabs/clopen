import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@qwen-code/sdk';
import type { AskUserQuestion } from '$shared/types/unified';
import { createSdkMessageConverter, toQwenAnswers } from './message-converter';

const questions: AskUserQuestion[] = [
	{ question: 'Which scope?', header: 'Scope', options: [{ label: 'All', description: 'a' }, { label: 'Some', description: 's' }], multiSelect: false },
	{ question: 'Which approach?', header: 'Approach', options: [{ label: 'Safe', description: 's' }, { label: 'Bold', description: 'b' }], multiSelect: false },
];

const askMessage = (id: string) => ({
	type: 'assistant',
	uuid: `a-${id}`,
	session_id: 's1',
	parent_tool_use_id: null,
	message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ask_user_question', input: { questions } }] },
}) as unknown as SDKMessage;

const resultMessage = (id: string, content: string, isError: boolean) => ({
	type: 'user',
	session_id: 's1',
	parent_tool_use_id: null,
	message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
}) as unknown as SDKMessage;

function toolResults(outputs: unknown[]) {
	return outputs.flatMap((o) => {
		const msg = o as { type: string; content?: Array<{ type: string; content?: string; isError?: boolean }> };
		return msg.type === 'user' ? (msg.content ?? []).filter(b => b.type === 'tool_result') : [];
	});
}

describe('toQwenAnswers', () => {
	// The CLI drops every non-index key and tells the model "No valid answers
	// were provided." — the frontend sends question-text keys.
	test('re-keys question-text answers by question index', () => {
		expect(toQwenAnswers(questions, { 'Which scope?': 'Some', 'Which approach?': 'Bold' })).toEqual({ '0': 'Some', '1': 'Bold' });
	});

	test('keeps index keys and skips unanswered questions', () => {
		expect(toQwenAnswers(questions, { '1': 'Safe' })).toEqual({ '1': 'Safe' });
	});
});

describe('AskUserQuestion tool_result', () => {
	test('an answered question renders as "<question>"="<answer>" pairs the UI card parses', () => {
		const converter = createSdkMessageConverter('m');
		[...converter.convert(askMessage('call_1'))];
		converter.recordUserAnswer('call_1', { 'Which scope?': 'Some', 'Which approach?': 'Bold' });
		const [result] = toolResults([...converter.convert(resultMessage('call_1', 'User has provided the following answers:\n\n**Scope**: Some', false))]);
		expect(result.isError).toBe(false);
		expect(result.content).toBe('User has answered your questions: "Which scope?"="Some", "Which approach?"="Bold". You can now continue with the user\'s answers in mind.');
	});

	test('a question the CLI cancelled stays an error, even if an answer arrived late', () => {
		const converter = createSdkMessageConverter('m');
		[...converter.convert(askMessage('call_2'))];
		converter.recordUserAnswer('call_2', { 'Which scope?': 'Some' });
		const cancelled = '[Operation Cancelled] Reason: The host could not present the required approval for "ask_user_question".';
		const [result] = toolResults([...converter.convert(resultMessage('call_2', cancelled, true))]);
		expect(result.isError).toBe(true);
		expect(result.content).toBe(cancelled);
	});
});
