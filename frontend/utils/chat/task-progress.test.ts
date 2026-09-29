import { describe, test, expect } from 'bun:test';
import { replayTaskTools } from './task-progress';

/**
 * Message shapes here mirror what the DB actually stores for a Claude turn: the
 * TaskCreate/TaskUpdate calls sit on an assistant message carrying the SDK
 * `sessionId`, and each call's result arrives as a tool_result block on a
 * separate synthetic user message.
 */

let toolSeq = 0;

function assistant(sessionId: string | null, ...blocks: unknown[]) {
	return { type: 'assistant', sessionId, content: blocks };
}

function create(subject: string, activeForm?: string) {
	return {
		type: 'tool_use',
		id: `toolu_${++toolSeq}`,
		name: 'TaskCreate',
		input: { subject, description: subject, ...(activeForm ? { activeForm } : {}) },
	};
}

function update(taskId: string, status?: string, extra: Record<string, unknown> = {}) {
	return {
		type: 'tool_use',
		id: `toolu_${++toolSeq}`,
		name: 'TaskUpdate',
		input: { taskId, ...(status ? { status } : {}), ...extra },
	};
}

/** The engine's real reply to TaskCreate, which is where the id comes from. */
function created(toolUseId: string, id: number, subject: string) {
	return {
		type: 'user',
		sessionId: null,
		content: [{
			type: 'tool_result',
			toolUseId,
			content: `Task #${id} created successfully: ${subject}`,
			isError: false,
		}],
	};
}

describe('replayTaskTools', () => {
	test('returns null when the conversation used no Task tool', () => {
		expect(replayTaskTools([])).toBeNull();
		expect(replayTaskTools([
			assistant('s1', { type: 'text', text: 'hello' }),
			assistant('s1', { type: 'tool_use', id: 'x', name: 'Read', input: {} }),
		])).toBeNull();
	});

	test('replays creates and status patches within one turn', () => {
		const a = create('Write the migration');
		const b = create('Run the tests');
		const todos = replayTaskTools([
			assistant('s1', a, b),
			created(a.id, 1, 'Write the migration'),
			created(b.id, 2, 'Run the tests'),
			assistant('s1', update('1', 'in_progress')),
			assistant('s1', update('1', 'completed'), update('2', 'in_progress')),
		]);

		expect(todos).toEqual([
			{ content: 'Write the migration', status: 'completed', activeForm: 'Write the migration' },
			{ content: 'Run the tests', status: 'in_progress', activeForm: 'Run the tests' },
		]);
	});

	test('a task created later in the same turn is appended, not a reset', () => {
		const a = create('One');
		const b = create('Two');
		const todos = replayTaskTools([
			assistant('s1', a),
			created(a.id, 1, 'One'),
			assistant('s1', update('1', 'completed')),
			assistant('s1', b),
			created(b.id, 2, 'Two'),
		]);

		expect(todos?.map((t) => [t.content, t.status])).toEqual([
			['One', 'completed'],
			['Two', 'pending'],
		]);
	});

	test('a new turn starts its own list because the engine restarts ids at 1', () => {
		// Exactly the reported bug: turn 1 creates three tasks and completes them,
		// turn 2 creates two more under a fresh SDK session whose ids also start
		// at 1. Keyed conversation-globally, turn 2's updates landed on turn 1's
		// rows and turn 2's own tasks never left `pending`.
		const t1 = [create('Alpha'), create('Beta'), create('Gamma')];
		const t2 = [create('Delta'), create('Epsilon')];

		const todos = replayTaskTools([
			assistant('turn-1', ...t1),
			created(t1[0].id, 1, 'Alpha'),
			created(t1[1].id, 2, 'Beta'),
			created(t1[2].id, 3, 'Gamma'),
			assistant('turn-1', update('1', 'completed'), update('2', 'completed'), update('3', 'completed')),
			assistant('turn-2', ...t2),
			created(t2[0].id, 1, 'Delta'),
			created(t2[1].id, 2, 'Epsilon'),
			assistant('turn-2', update('1', 'completed'), update('2', 'in_progress')),
		]);

		expect(todos).toEqual([
			{ content: 'Delta', status: 'completed', activeForm: 'Delta' },
			{ content: 'Epsilon', status: 'in_progress', activeForm: 'Epsilon' },
		]);
	});

	test('a turn that only patches continues the carried list', () => {
		// No TaskCreate, so nothing opened a new namespace — the patches belong to
		// the list already held. Guards the case where the engine starts persisting
		// its task store across a fork.
		const a = create('Alpha');
		const todos = replayTaskTools([
			assistant('turn-1', a),
			created(a.id, 1, 'Alpha'),
			assistant('turn-2', update('1', 'completed')),
		]);

		expect(todos).toEqual([
			{ content: 'Alpha', status: 'completed', activeForm: 'Alpha' },
		]);
	});

	test('falls back to creation order while the result is still in flight', () => {
		// Live streaming: the TaskCreate block renders before its tool_result
		// arrives, and within a namespace the engine numbers creates from 1.
		const todos = replayTaskTools([
			assistant('s1', create('Alpha'), create('Beta')),
			assistant('s1', update('2', 'in_progress')),
		]);

		expect(todos?.map((t) => [t.content, t.status])).toEqual([
			['Alpha', 'pending'],
			['Beta', 'in_progress'],
		]);
	});

	test('ignores a patch for an unknown id unless it names the task', () => {
		// The loaded message window can open partway through a turn, leaving
		// updates whose creates are not in view. A bare status patch used to enter
		// the list as a task literally labelled "7".
		const bare = replayTaskTools([assistant('s1', update('7', 'completed'))]);
		expect(bare).toEqual([]);

		const named = replayTaskTools([
			assistant('s1', update('7', 'completed', { subject: 'Recovered task' })),
		]);
		expect(named).toEqual([
			{ content: 'Recovered task', status: 'completed', activeForm: 'Recovered task' },
		]);
	});

	test('deleted removes the task and closes the gap', () => {
		const a = create('Alpha');
		const b = create('Beta');
		const c = create('Gamma');
		const todos = replayTaskTools([
			assistant('s1', a, b, c),
			created(a.id, 1, 'Alpha'),
			created(b.id, 2, 'Beta'),
			created(c.id, 3, 'Gamma'),
			assistant('s1', update('2', 'deleted')),
		]);

		expect(todos?.map((t) => t.content)).toEqual(['Alpha', 'Gamma']);
	});

	test('activeForm falls back to the subject and survives a patch', () => {
		const a = create('Run tests', 'Running tests');
		const todos = replayTaskTools([
			assistant('s1', a),
			created(a.id, 1, 'Run tests'),
			assistant('s1', update('1', 'in_progress')),
		]);

		expect(todos).toEqual([
			{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
		]);
	});
});
