/**
 * The pool's promises: jobs run off the calling thread in order, a cancelled
 * job never answers, and cancelling a RUNNING job actually stops its work —
 * the worker is terminated and the next job gets a fresh one.
 */

import { describe, expect, test } from 'bun:test';

import { DiffPool, type DiffWorkerLike } from './diff-pool';
import { runDiffJob, type DiffJobRequest, type DiffJobResponse } from './diff-tasks';

/** A worker that only answers when the test says so. */
class ManualWorker implements DiffWorkerLike {
	onmessage: ((event: MessageEvent<DiffJobResponse>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	received: DiffJobRequest[] = [];
	terminated = false;

	postMessage(message: DiffJobRequest): void {
		this.received.push(message);
	}
	terminate(): void {
		this.terminated = true;
	}
	/** Finish the oldest job it was handed, with the real task table. */
	answer(): void {
		const request = this.received.shift()!;
		this.onmessage?.({ data: runDiffJob(request) } as MessageEvent<DiffJobResponse>);
	}
	crash(message: string): void {
		this.onerror?.({ message } as ErrorEvent);
	}
}

function poolWith(size: number) {
	const workers: ManualWorker[] = [];
	const pool = new DiffPool(() => {
		const worker = new ManualWorker();
		workers.push(worker);
		return worker;
	}, size);
	return { pool, workers };
}

const counts = { oldContent: 'a\nb\n', newContent: 'a\nB\n' };

describe('DiffPool', () => {
	test('answers with the task result', async () => {
		const { pool, workers } = poolWith(1);
		const result = pool.run('count', counts);
		workers[0].answer();
		expect(await result).toEqual({ additions: 1, deletions: 1 });
	});

	test('queues behind a busy worker and runs in order', async () => {
		const { pool, workers } = poolWith(1);
		const first = pool.run('count', counts);
		const second = pool.run('count', { oldContent: '', newContent: 'x\n' });
		expect(workers[0].received).toHaveLength(1);

		workers[0].answer();
		expect(await first).toEqual({ additions: 1, deletions: 1 });
		workers[0].answer();
		expect(await second).toEqual({ additions: 1, deletions: 0 });
	});

	test('a queued job that is cancelled is never sent', async () => {
		const { pool, workers } = poolWith(1);
		void pool.run('count', counts);
		const controller = new AbortController();
		const dropped = pool.run('count', counts, controller.signal);
		controller.abort();

		await expect(dropped).rejects.toBeDefined();
		workers[0].answer();
		expect(workers[0].received).toHaveLength(0);
	});

	test('cancelling a running job terminates its worker and the next job gets a new one', async () => {
		const { pool, workers } = poolWith(1);
		const controller = new AbortController();
		const running = pool.run('count', counts, controller.signal);
		const next = pool.run('count', { oldContent: '', newContent: 'x\n' });

		controller.abort();
		await expect(running).rejects.toBeDefined();
		expect(workers[0].terminated).toBe(true);

		expect(workers).toHaveLength(2);
		workers[1].answer();
		expect(await next).toEqual({ additions: 1, deletions: 0 });
	});

	test('a crashed worker fails its job and is replaced', async () => {
		const { pool, workers } = poolWith(1);
		const failing = pool.run('count', counts);
		workers[0].crash('out of memory');
		await expect(failing).rejects.toThrow('out of memory');

		const after = pool.run('count', counts);
		expect(workers).toHaveLength(2);
		workers[1].answer();
		expect(await after).toEqual({ additions: 1, deletions: 1 });
	});

	test('uses a second worker so one slow job does not hold up the rest', () => {
		const { pool, workers } = poolWith(2);
		void pool.run('count', counts);
		void pool.run('count', counts);
		expect(workers).toHaveLength(2);
		expect(workers[0].received).toHaveLength(1);
		expect(workers[1].received).toHaveLength(1);
	});
});
