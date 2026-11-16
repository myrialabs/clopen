/**
 * What a plan shows as running comes from the run itself, step by step —
 * and a run being replaced mid-way cannot erase the new run's steps.
 */

import { describe, expect, it } from 'bun:test';
import { runningSteps, stepEnded, stepStarted } from './live-steps';

describe('live steps', () => {
	it('lists the steps under way, outermost first, and forgets them as they end', () => {
		stepStarted('task-a', '2');
		stepStarted('task-a', '2.r1.1');
		expect(runningSteps('task-a')).toEqual(['2', '2.r1.1']);
		stepEnded('task-a', '2.r1.1');
		stepEnded('task-a', '2');
		expect(runningSteps('task-a')).toEqual([]);
	});

	it('keeps a step the new run started when the replaced run unwinds the same one', () => {
		stepStarted('task-b', '1'); // the old run
		stepStarted('task-b', '1'); // the new run, started before the old one stopped
		stepEnded('task-b', '1'); // the old run unwinds
		expect(runningSteps('task-b')).toEqual(['1']);
		stepEnded('task-b', '1');
		stepEnded('task-b', '1'); // an extra end does nothing
		expect(runningSteps('task-b')).toEqual([]);
	});
});
