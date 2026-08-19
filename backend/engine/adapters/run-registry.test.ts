import { describe, expect, test } from 'bun:test';

import { EngineRuns } from './run-registry';

// One engine instance serves every chat session of a project, so a cancel has to
// name the stream it means. These cases are the difference between "Stop this
// chat" and "Stop whatever this engine happens to be doing" — the second one
// interrupted a different chat mid-answer.

interface Run {
	controller: AbortController;
	label: string;
}

function registry(...labels: string[]) {
	const runs = new EngineRuns<Run>();
	const byLabel: Record<string, Run> = {};
	for (const label of labels) {
		byLabel[label] = runs.add({ controller: new AbortController(), label });
	}
	return { runs, byLabel };
}

describe('EngineRuns', () => {
	test('an owner selects its own run and leaves the others alone', () => {
		const { runs, byLabel } = registry('a', 'b');

		expect(runs.select(byLabel.a.controller).map(r => r.label)).toEqual(['a']);
		expect(runs.select(byLabel.b.controller).map(r => r.label)).toEqual(['b']);
	});

	test('an owner that already finished selects nothing', () => {
		const { runs, byLabel } = registry('a', 'b');
		runs.remove(byLabel.a);

		// The tempting fallback — "target not found, so stop what's left" — is
		// exactly the bug: it would take down 'b', a chat the user never stopped.
		expect(runs.select(byLabel.a.controller)).toEqual([]);
	});

	test('all() returns every run, for dispose and shutdown', () => {
		const { runs } = registry('a', 'b');

		expect(runs.all().map(r => r.label).sort()).toEqual(['a', 'b']);
	});

	test('isActive stays true until the LAST run ends', () => {
		const { runs, byLabel } = registry('a', 'b');

		expect(runs.isActive).toBe(true);
		runs.remove(byLabel.a);
		// An engine retired mid-stream is disposed once it goes idle. Reporting
		// idle here would dispose it out from under 'b'.
		expect(runs.isActive).toBe(true);
		runs.remove(byLabel.b);
		expect(runs.isActive).toBe(false);
	});

	test('removing a run twice is not an error', () => {
		const { runs, byLabel } = registry('a');

		// cancel() and the stream's own `finally` both retire the run.
		runs.remove(byLabel.a);
		runs.remove(byLabel.a);
		expect(runs.isActive).toBe(false);
	});

	test('an empty registry is not an error', () => {
		const runs = new EngineRuns<Run>();

		expect(runs.all()).toEqual([]);
		expect(runs.select(new AbortController())).toEqual([]);
		expect(runs.isActive).toBe(false);
	});
});
