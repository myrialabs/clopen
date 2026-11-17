/**
 * A stream shows "waiting for background work" only between turns: after an
 * engine turn's result, while background work it started is still running.
 */

import { describe, it, expect } from 'bun:test';
import { waitingOnBackground } from './stream-manager';

const task = (id: string) => ({ id });

describe('waitingOnBackground', () => {
	it('counts the tasks of an active stream between turns', () => {
		expect(waitingOnBackground({ status: 'active', betweenTurns: true, backgroundTasks: [task('a'), task('b')] })).toBe(2);
	});

	it('is 0 while the engine is producing output, even with work running', () => {
		expect(waitingOnBackground({ status: 'active', betweenTurns: false, backgroundTasks: [task('a')] })).toBe(0);
	});

	it('is 0 between turns once nothing runs in the background', () => {
		expect(waitingOnBackground({ status: 'active', betweenTurns: true, backgroundTasks: [] })).toBe(0);
		expect(waitingOnBackground({ status: 'active', betweenTurns: true })).toBe(0);
	});

	it('is 0 for a stream that is no longer active', () => {
		expect(waitingOnBackground({ status: 'completed', betweenTurns: true, backgroundTasks: [task('a')] })).toBe(0);
	});
});
