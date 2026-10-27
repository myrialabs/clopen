/**
 * A prompt a chat sent is followed by its own id — a photo with no caption is
 * matched as surely as text, and a message still in the queue can be found
 * again by the chat message that sent it.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { expectTurn, forgetExpectedTurn, liveTurn, onUserMessage, queuedPromptFor, resetTurns, setExpectedQueueId, takeStoppedByChat, markStoppedByChat } from './turns';

const prompt = (promptMessageId: string, platformMessageId: string | null = '100') => ({
	linkId: 'link-1',
	accountId: 'acc',
	conversationId: 'chat',
	projectId: 'p',
	platformMessageId,
	promptMessageId
});

afterEach(() => resetTurns());

describe('turns a chat started', () => {
	it('match the saved user message by the prompt id, not its text', () => {
		// No chat message to map (like /retry), so no row is written.
		expectTurn('s1', prompt('prompt-a', null));
		expect(onUserMessage('s1', 'saved-x', 'someone-else')).toBeNull();
		const turn = onUserMessage('s1', 'saved-a', 'prompt-a');
		expect(turn?.promptMessageId).toBe('prompt-a');
		expect(liveTurn('s1')).toBe(turn);
	});

	it('can be found while queued, and forgotten when sending failed', () => {
		expectTurn('s1', prompt('prompt-b', '200'));
		expect(queuedPromptFor('link-1', '200')).toBeNull();
		setExpectedQueueId('s1', 'prompt-b', 'queue-1');
		expect(queuedPromptFor('link-1', '200')?.prompt.queueId).toBe('queue-1');
		forgetExpectedTurn('s1', 'prompt-b');
		expect(queuedPromptFor('link-1', '200')).toBeNull();
	});

	it('remember once that this chat stopped the turn', () => {
		markStoppedByChat('s2');
		expect(takeStoppedByChat('s2')).toBe(true);
		expect(takeStoppedByChat('s2')).toBe(false);
	});
});
