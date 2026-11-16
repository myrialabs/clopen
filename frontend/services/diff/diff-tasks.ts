/**
 * Everything the browser asks the diff worker to compute.
 *
 * Each task is a pure, synchronous function over the shared engine
 * (`$shared/utils/diff-calculator`) — the worker runs it to the end on its own
 * thread, and the pool can abandon it mid-way by terminating that thread. Kept
 * in one table so the worker, the pool and their types cannot drift apart.
 */

import { countLineChanges } from '$shared/utils/diff-calculator';
import { computeDiffBlock } from '$frontend/utils/diff-block';
import { computeLineDiff } from '$frontend/utils/line-diff';
import { buildLineMap, remapHunks } from '$frontend/utils/line-map';

export const diffTasks = {
	/** Rows of a rendered diff block (tool rows, conflict previews). */
	block: (input: { oldString: string; newString: string; highlights: boolean }) =>
		computeDiffBlock(input.oldString, input.newString, { highlights: input.highlights }),

	/** +/- line counts, as every badge shows them. */
	count: (input: { oldContent: string; newContent: string }) =>
		countLineChanges(input.oldContent, input.newContent),

	/** Editor gutter hunks for `after` against `before`. */
	gutter: (input: { before: string; after: string }) => computeLineDiff(input.before, input.after),

	/**
	 * A turn's own hunks (its before against its after), carried onto the buffer
	 * through the diff between the turn's after and what is on screen now.
	 */
	turnGutter: (input: { before: string; after: string; buffer: string }) =>
		remapHunks(
			computeLineDiff(input.before, input.after),
			buildLineMap(computeLineDiff(input.after, input.buffer))
		)
};

export type DiffTaskName = keyof typeof diffTasks;
export type DiffTaskInput<K extends DiffTaskName> = Parameters<(typeof diffTasks)[K]>[0];
export type DiffTaskOutput<K extends DiffTaskName> = ReturnType<(typeof diffTasks)[K]>;

export interface DiffJobRequest {
	id: number;
	task: DiffTaskName;
	input: unknown;
}

export type DiffJobResponse = { id: number; result: unknown } | { id: number; error: string };

/** Run one job — the worker's whole body, and the pool's fallback without workers. */
export function runDiffJob(request: DiffJobRequest): DiffJobResponse {
	try {
		const run = diffTasks[request.task] as (input: unknown) => unknown;
		return { id: request.id, result: run(request.input) };
	} catch (error) {
		return { id: request.id, error: error instanceof Error ? error.message : String(error) };
	}
}
