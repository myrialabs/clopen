/**
 * When a turn's tools were running.
 *
 * The window must open at the engine's previous output, not at the call: an
 * engine that reports a command only after it finished sends the call and the
 * result together, and the command ran in the silence before them.
 */

import { describe, it, expect } from 'bun:test';
import { TurnActivity } from './turn-activity';

const call = (id: string) => ({ type: 'assistant', content: [{ type: 'tool_use', id }] });
const result = (id: string) => ({ type: 'user', content: [{ type: 'tool_result', toolUseId: id }] });

describe('TurnActivity', () => {
	it('covers the span from the previous output to the result', () => {
		const activity = new TurnActivity(0);
		activity.observe({ type: 'stream_event' }, 10_000);
		activity.observe(call('a'), 20_000);
		activity.observe(result('a'), 30_000);

		expect(activity.wasRunningAt(15_000)).toBe(true);
		expect(activity.wasRunningAt(30_500)).toBe(true);
		expect(activity.wasRunningAt(5_000)).toBe(false);
		expect(activity.wasRunningAt(40_000)).toBe(false);
	});

	it('covers a command reported only after it finished', () => {
		const activity = new TurnActivity(0);
		activity.observe({ type: 'assistant', content: [{ type: 'text' }] }, 10_000);
		activity.observe(call('cmd'), 50_000);
		activity.observe(result('cmd'), 50_001);

		expect(activity.wasRunningAt(30_000)).toBe(true);
	});

	it('treats a call without a result as still running', () => {
		const activity = new TurnActivity(0);
		activity.observe({ type: 'stream_event' }, 10_000);
		activity.observe(call('stuck'), 11_000);

		expect(activity.wasRunningAt(99_000)).toBe(true);
	});

	it('does not count model output with no tool as running', () => {
		const activity = new TurnActivity(0);
		activity.observe({ type: 'assistant', content: [{ type: 'text' }] }, 10_000);
		activity.observe({ type: 'stream_event' }, 20_000);

		expect(activity.wasRunningAt(15_000)).toBe(false);
	});
});
