/**
 * The orders below were recorded from the Claude Agent SDK 0.3.296 with
 * CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1.
 */

import { describe, it, expect } from 'bun:test';
import { ClaudeInputGate, type InputGateMessage } from './input-gate';

const state = (s: string): InputGateMessage => ({ type: 'system', subtype: 'session_state_changed', state: s });
const tasks = (n: number): InputGateMessage => ({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, i) => ({ task_id: `t${i}` })) });
const notification: InputGateMessage = { type: 'system', subtype: 'task_notification' };
const assistant: InputGateMessage = { type: 'assistant' };
const result: InputGateMessage = { type: 'result' };

function run(messages: InputGateMessage[]): number[] {
	const closedAt: number[] = [];
	let index = -1;
	const gate = new ClaudeInputGate(() => closedAt.push(index));
	for (index = 0; index < messages.length; index++) gate.observe(messages[index]);
	return closedAt;
}

describe('ClaudeInputGate', () => {
	it('stays open through the first result while a background task runs, and closes after the turn it starts', () => {
		const order = [
			state('running'), assistant, tasks(1), assistant, result,
			state('idle'), // idle WHILE the background task still runs
			notification, tasks(0), state('running'), assistant, result,
			state('idle')
		];
		expect(run(order)).toEqual([order.length - 1]);
	});

	it('closes at the first idle when a background task finished mid-turn', () => {
		const order = [state('running'), assistant, tasks(1), notification, tasks(0), notification, assistant, result, state('idle')];
		expect(run(order)).toEqual([order.length - 1]);
	});

	it('closes at the first idle of a turn without background work', () => {
		const order = [state('running'), assistant, result, state('idle')];
		expect(run(order)).toEqual([3]);
	});

	it('without session-state events, closes on a result with no background task', () => {
		expect(run([assistant, result])).toEqual([1]);
		const order = [assistant, tasks(1), result, notification, tasks(0), assistant, result];
		expect(run(order)).toEqual([order.length - 1]);
	});

	it('closes once', () => {
		let calls = 0;
		const gate = new ClaudeInputGate(() => calls++);
		gate.observe(result);
		gate.shut();
		gate.observe(state('idle'));
		expect(calls).toBe(1);
		expect(gate.isClosed).toBe(true);
	});
});
