/**
 * Diff Worker Pool
 *
 * The browser's only way to run a diff. Jobs go to a small pool of workers
 * (`diff.worker.ts`), so a slow job never touches the main thread and never
 * holds up the jobs behind it on the other worker.
 *
 * Cancellation is real, not a flag: an aborted job that is still queued is
 * dropped, and one that is already running has its worker terminated — the
 * only way to stop a synchronous computation — and replaced on demand. That
 * is what keeps the editor gutter from stacking up stale diffs while the user
 * types.
 */

import {
	runDiffJob,
	type DiffJobRequest,
	type DiffJobResponse,
	type DiffTaskInput,
	type DiffTaskName,
	type DiffTaskOutput
} from './diff-tasks';

/** The part of `Worker` the pool uses, so tests can stand in for it. */
export interface DiffWorkerLike {
	postMessage(message: DiffJobRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<DiffJobResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}

interface Job {
	request: DiffJobRequest;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface Slot {
	worker: DiffWorkerLike | null;
	job: Job | null;
}

export class DiffPool {
	private readonly slots: Slot[];
	private readonly queue: Job[] = [];
	private nextId = 1;

	constructor(
		private readonly createWorker: () => DiffWorkerLike,
		size: number
	) {
		this.slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: null, job: null }));
	}

	run<K extends DiffTaskName>(task: K, input: DiffTaskInput<K>, signal?: AbortSignal): Promise<DiffTaskOutput<K>> {
		return new Promise<DiffTaskOutput<K>>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			const job: Job = {
				request: { id: this.nextId++, task, input },
				resolve: resolve as (value: unknown) => void,
				reject,
				signal
			};
			if (signal) {
				job.onAbort = () => this.abort(job);
				signal.addEventListener('abort', job.onAbort, { once: true });
			}
			this.queue.push(job);
			this.dispatch();
		});
	}

	/** Stop every worker and fail whatever was pending. */
	dispose(): void {
		for (const job of this.queue.splice(0)) this.settle(job, new Error('diff pool disposed'));
		for (const slot of this.slots) {
			if (slot.job) this.settle(slot.job, new Error('diff pool disposed'));
			slot.job = null;
			slot.worker?.terminate();
			slot.worker = null;
		}
	}

	private dispatch(): void {
		for (const slot of this.slots) {
			if (slot.job || this.queue.length === 0) continue;
			const job = this.queue.shift()!;
			slot.job = job;
			this.workerFor(slot).postMessage(job.request);
		}
	}

	private workerFor(slot: Slot): DiffWorkerLike {
		if (slot.worker) return slot.worker;
		const worker = this.createWorker();
		worker.onmessage = (event) => {
			const job = slot.job;
			if (!job || job.request.id !== event.data.id) return;
			slot.job = null;
			if ('error' in event.data) this.settle(job, new Error(event.data.error));
			else this.settle(job, null, event.data.result);
			this.dispatch();
		};
		worker.onerror = (event) => {
			// A worker that crashed is not trusted with the next job.
			const job = slot.job;
			slot.job = null;
			worker.terminate();
			if (slot.worker === worker) slot.worker = null;
			if (job) this.settle(job, new Error(event.message || 'diff worker failed'));
			this.dispatch();
		};
		slot.worker = worker;
		return worker;
	}

	private abort(job: Job): void {
		const queued = this.queue.indexOf(job);
		if (queued !== -1) {
			this.queue.splice(queued, 1);
		} else {
			const slot = this.slots.find((candidate) => candidate.job === job);
			if (!slot) return;
			// The only way to stop a synchronous computation is to end its thread.
			slot.worker?.terminate();
			slot.worker = null;
			slot.job = null;
		}
		this.settle(job, job.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		this.dispatch();
	}

	private settle(job: Job, error: unknown, result?: unknown): void {
		if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
		if (error) job.reject(error);
		else job.resolve(result);
	}
}

/**
 * Stand-in for environments without `Worker` (the test runner). It answers on
 * the next microtask from the same task table, so behaviour is identical —
 * only the thread differs.
 */
function inlineWorker(): DiffWorkerLike {
	const worker: DiffWorkerLike = {
		onmessage: null,
		onerror: null,
		postMessage(request) {
			queueMicrotask(() => worker.onmessage?.({ data: runDiffJob(request) } as MessageEvent<DiffJobResponse>));
		},
		terminate() {
			worker.onmessage = null;
		}
	};
	return worker;
}

function browserWorker(): DiffWorkerLike {
	return new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' }) as unknown as DiffWorkerLike;
}

let pool: DiffPool | null = null;

/**
 * Run a diff task off the main thread. Pass a signal to drop the answer — and
 * the work — once it is no longer wanted.
 */
export function runDiff<K extends DiffTaskName>(
	task: K,
	input: DiffTaskInput<K>,
	signal?: AbortSignal
): Promise<DiffTaskOutput<K>> {
	if (!pool) {
		// A page, not just a runtime that happens to define `Worker` (Bun's is
		// experimental, and the test runner has no bundler to resolve the URL).
		const hasWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';
		// Two workers: one pathological diff must not delay every other one.
		const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
		pool = new DiffPool(hasWorker ? browserWorker : inlineWorker, hasWorker ? Math.min(2, Math.max(1, cores - 1)) : 1);
	}
	return pool.run(task, input, signal);
}

/** True for the rejection an aborted `runDiff` produces — expected, not an error. */
export function isDiffAbort(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}
