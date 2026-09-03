import { beforeEach, describe, expect, test } from 'bun:test';
import { dismissPrune, pruneJobFor, resetPruneJobs, startPrune } from './prune-job';
import type { PruneKind, PruneOutcome } from '$shared/types/containers';

const HOST = 'local';
const USER = 'user-1';

/** A sweep the test finishes by hand, so a job can be observed mid-flight. */
function deferredSweep() {
	let finish: (outcomes: PruneOutcome[]) => void = () => {};
	let fail: (error: Error) => void = () => {};
	let calls = 0;
	const sweep = (): Promise<PruneOutcome[]> => {
		calls += 1;
		return new Promise<PruneOutcome[]>((resolve, reject) => {
			finish = resolve;
			fail = reject;
		});
	};
	return {
		sweep,
		get calls() {
			return calls;
		},
		finish: (outcomes: PruneOutcome[] = []) => finish(outcomes),
		fail: (error: Error) => fail(error)
	};
}

/** Let the job's own `.then` chain run before asserting on what it wrote. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const outcome = (kind: PruneKind): PruneOutcome => ({
	kind,
	ok: true,
	removed: 3,
	reclaimed: '1.2GB',
	error: null
});

beforeEach(() => resetPruneJobs());

describe('startPrune', () => {
	test('a started sweep is running and carries what it is sweeping', () => {
		const driver = deferredSweep();
		const job = startPrune(HOST, ['volumes'], USER, driver.sweep);

		expect(job.hostId).toBe(HOST);
		expect(job.kinds).toEqual(['volumes']);
		expect(job.finishedAt).toBeNull();
		expect(job.outcomes).toBeNull();
		expect(driver.calls).toBe(1);
	});

	test('asking again while one runs returns that job and starts nothing', () => {
		const driver = deferredSweep();
		const first = startPrune(HOST, ['volumes'], USER, driver.sweep);
		// The case this guards: a user who lost track of the first sweep. Two
		// prunes racing on the same disk report two sets of half-true numbers.
		const second = startPrune(HOST, ['images'], 'user-2', driver.sweep);

		expect(second).toBe(first);
		expect(second.kinds).toEqual(['volumes']);
		expect(driver.calls).toBe(1);
	});

	test('a finished sweep keeps its outcomes for whoever reads next', async () => {
		const driver = deferredSweep();
		startPrune(HOST, ['volumes'], USER, driver.sweep);
		driver.finish([outcome('volumes')]);
		await settle();

		const job = pruneJobFor(HOST, USER);
		expect(job?.finishedAt).not.toBeNull();
		expect(job?.outcomes).toEqual([outcome('volumes')]);
	});

	test('a sweep that throws finishes as a failure rather than staying running', async () => {
		const driver = deferredSweep();
		startPrune(HOST, ['volumes', 'images'], USER, driver.sweep);
		driver.fail(new Error('daemon went away'));
		await settle();

		const job = pruneJobFor(HOST, USER);
		// Left running, the host would refuse every later sweep forever.
		expect(job?.finishedAt).not.toBeNull();
		expect(job?.outcomes).toHaveLength(2);
		expect(job?.outcomes?.every((entry) => !entry.ok)).toBe(true);
		expect(job?.outcomes?.[0]?.error).toBe('daemon went away');
	});

	test('a new sweep may start once the last one finished', async () => {
		const first = deferredSweep();
		startPrune(HOST, ['volumes'], USER, first.sweep);
		first.finish([outcome('volumes')]);
		await settle();

		const second = deferredSweep();
		const job = startPrune(HOST, ['images'], USER, second.sweep);
		expect(job.kinds).toEqual(['images']);
		expect(job.finishedAt).toBeNull();
		expect(second.calls).toBe(1);
	});

	test('each host sweeps independently', () => {
		const local = deferredSweep();
		const remote = deferredSweep();
		startPrune('local', ['volumes'], USER, local.sweep);
		startPrune('ssh-host', ['images'], USER, remote.sweep);

		expect(pruneJobFor('local', USER)?.kinds).toEqual(['volumes']);
		expect(pruneJobFor('ssh-host', USER)?.kinds).toEqual(['images']);
	});
});

describe('pruneJobFor', () => {
	test('a host that never swept has no job', () => {
		expect(pruneJobFor(HOST, USER)).toBeNull();
	});

	test('a sweep started by someone else is still found', () => {
		const driver = deferredSweep();
		startPrune(HOST, ['volumes'], 'user-1', driver.sweep);
		// The refresh-and-second-device case: whoever looks sees the real state.
		expect(pruneJobFor(HOST, 'user-2')?.kinds).toEqual(['volumes']);
	});
});

describe('dismissPrune', () => {
	test('a finished report is forgotten once acknowledged', async () => {
		const driver = deferredSweep();
		startPrune(HOST, ['volumes'], USER, driver.sweep);
		driver.finish([outcome('volumes')]);
		await settle();

		dismissPrune(HOST);
		expect(pruneJobFor(HOST, USER)).toBeNull();
	});

	test('a running sweep is never dismissed', () => {
		const driver = deferredSweep();
		startPrune(HOST, ['volumes'], USER, driver.sweep);

		dismissPrune(HOST);
		// Forgetting it here would hand the next caller a second concurrent sweep.
		expect(pruneJobFor(HOST, USER)?.finishedAt).toBeNull();
	});
});
