/**
 * "The next thing you type is for this": one per chat, newest wins, used
 * once, and it lapses.
 */

import { describe, it, expect, afterEach, setSystemTime } from 'bun:test';
import { clearAwaiting, hasAwaiting, isAwaiting, resetAwaiting, setAwaiting, takeAwaiting } from './awaiting';

afterEach(() => {
	resetAwaiting();
	setSystemTime();
});

describe('awaiting typed words', () => {
	it('is taken once, and the newest ask wins', () => {
		setAwaiting('link', { kind: 'question', rowId: 'q1' });
		setAwaiting('link', { kind: 'ask', rowId: 'a1' });
		expect(isAwaiting('link', 'q1')).toBe(false);
		expect(takeAwaiting('link')).toEqual({ kind: 'ask', rowId: 'a1' });
		expect(takeAwaiting('link')).toBeNull();
	});

	it('knows whether the chat is waiting at all', () => {
		expect(hasAwaiting('link')).toBe(false);
		setAwaiting('link', { kind: 'ask', rowId: 'a1' });
		expect(hasAwaiting('link')).toBe(true);
		expect(hasAwaiting('other-link')).toBe(false);
	});

	it('lapses, and a command clears it', () => {
		setAwaiting('link', { kind: 'question', rowId: 'q1' });
		setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
		expect(takeAwaiting('link')).toBeNull();
		setSystemTime();
		setAwaiting('link', { kind: 'question', rowId: 'q1' });
		clearAwaiting('link');
		expect(takeAwaiting('link')).toBeNull();
	});
});
