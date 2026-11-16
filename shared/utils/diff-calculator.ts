/**
 * Diff Calculator Utility
 *
 * The ONE line-diff engine in Clopen. Every "+N / -M" number (checkpoint stats,
 * the Changes tab, AI-change markers, Edit tool rows) and every rendered diff
 * (tool diff blocks, restore and worktree conflict previews, the editor change
 * gutter, the dotenv preview) comes from `matchTask` below, so no two surfaces
 * can disagree about the same change.
 *
 * The engine is exact — it finds a longest common subsequence, i.e. a minimal
 * edit script, the same numbers `git diff --stat` reports — and its cost
 * follows the size of the CHANGE, not the size of the input. Each surface used
 * to carry its own old×new LCS table: a 47k-line String Catalog edited by a few
 * hundred lines needed 2.3 billion cells (~18 GB) on the server's only thread
 * and froze every WebSocket of every user. Here the same edit is a few
 * milliseconds, and memory stays linear in the input.
 *
 * Exact still has a worst case — no exact algorithm escapes one — so the work
 * is RESUMABLE: it pauses at safe points and two drivers decide what a pause
 * means. `runSliced` hands the thread back to the event loop every few
 * milliseconds, which is what the server uses so a pathological diff can never
 * stall a WebSocket. `runToEnd` ignores the pauses, which is what the browser's
 * diff worker uses (it has its own thread to spend) and what tests use. The
 * steps, and therefore the result, are identical under both.
 *
 * "Binary-safe" means binary files are not line-counted at all. Splitting a PNG
 * on newline bytes yields a line count with no meaning, and two screenshots
 * once reported +159 lines into a checkpoint's total — dwarfing the source
 * changes the number was there to describe.
 */

/**
 * Whether these bytes are binary, and so cannot be counted or diffed as lines.
 * A NUL byte in the first few KB is the same heuristic git uses.
 */
export function isBinaryBuffer(buf: Buffer): boolean {
	const limit = Math.min(buf.length, 8000);
	for (let i = 0; i < limit; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

// ============================================================================
// Resumable work
// ============================================================================

/** A computation that may pause: every `yield` is a point where it is safe to stop. */
export type Resumable<T> = Generator<void, T, void>;

/** Units of work (compared elements, visited diagonals) between pause points. */
const WORK_PER_PAUSE = 1 << 14;

/** How long `runSliced` may hold the thread before handing it back. */
const SLICE_MS = 8;

/** Run to completion on the current thread, ignoring every pause point. */
export function runToEnd<T>(task: Resumable<T>): T {
	for (;;) {
		const step = task.next();
		if (step.done) return step.value;
	}
}

/**
 * Run cooperatively: at most ~SLICE_MS at a time, then yield to the event loop
 * so sockets, timers and other requests are served in between. Rejects with the
 * signal's reason once it is aborted.
 */
export async function runSliced<T>(task: Resumable<T>, signal?: AbortSignal): Promise<T> {
	let sliceStart = performance.now();
	for (;;) {
		signal?.throwIfAborted();
		const step = task.next();
		if (step.done) return step.value;
		if (performance.now() - sliceStart >= SLICE_MS) {
			await yieldToEventLoop();
			sliceStart = performance.now();
		}
	}
}

function yieldToEventLoop(): Promise<void> {
	// setImmediate runs after pending I/O (Bun, Node); browsers only have timers.
	return new Promise((resolve) =>
		typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)
	);
}

// ============================================================================
// Public API
// ============================================================================

/** One step of an edit script, indexed into the two input sequences. */
export type DiffOp =
	| { type: 'keep'; oldIndex: number; newIndex: number }
	| { type: 'delete'; oldIndex: number }
	| { type: 'insert'; newIndex: number };

export interface LineChangeCount {
	additions: number;
	deletions: number;
}

/**
 * Count only the lines that actually changed between two strings — identical
 * (context) lines are excluded, exactly as `git diff --stat` counts them. Use
 * this for +/- badges instead of naively counting every line of each side.
 */
export function* countLineChangesTask(oldContent: string, newContent: string): Resumable<LineChangeCount> {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	const common = (yield* matchTask(oldLines, newLines)).length;
	return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/**
 * A minimal edit script turning `a` into `b`. Within each changed region the
 * deletions come before the insertions, as in a unified diff.
 */
export function* diffSequencesTask(a: readonly string[], b: readonly string[]): Resumable<DiffOp[]> {
	const matches = yield* matchTask(a, b);
	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	for (const [mi, mj] of matches) {
		while (i < mi) ops.push({ type: 'delete', oldIndex: i++ });
		while (j < mj) ops.push({ type: 'insert', newIndex: j++ });
		ops.push({ type: 'keep', oldIndex: i++, newIndex: j++ });
	}
	while (i < a.length) ops.push({ type: 'delete', oldIndex: i++ });
	while (j < b.length) ops.push({ type: 'insert', newIndex: j++ });
	return ops;
}

/** Synchronous drivers — for a worker thread and for tests, never a shared thread. */
export const countLineChanges = (oldContent: string, newContent: string): LineChangeCount =>
	runToEnd(countLineChangesTask(oldContent, newContent));
export const diffSequences = (a: readonly string[], b: readonly string[]): DiffOp[] =>
	runToEnd(diffSequencesTask(a, b));
export const matchSequences = (a: readonly string[], b: readonly string[]): Array<[number, number]> =>
	runToEnd(matchTask(a, b));
/** How many elements two sequences share, in order (their LCS length). */
export const countCommon = (a: readonly string[], b: readonly string[]): number => matchSequences(a, b).length;

/** Cooperative drivers — for the server's event loop. */
export const countLineChangesAsync = (oldContent: string, newContent: string, signal?: AbortSignal) =>
	runSliced(countLineChangesTask(oldContent, newContent), signal);
export const diffSequencesAsync = (a: readonly string[], b: readonly string[], signal?: AbortSignal) =>
	runSliced(diffSequencesTask(a, b), signal);

// ============================================================================
// Engine
// ============================================================================

/**
 * The matched (oldIndex, newIndex) pairs of a longest common subsequence, in
 * increasing order. Everything else in this module is derived from this.
 *
 * Every reduction below keeps the result exact; they only shrink what the
 * Myers search has to walk:
 *  1. A shared head and tail are common by definition — an edit in the middle
 *     of a huge file leaves only the edited region.
 *  2. Elements are interned to integers, so the search compares numbers, not
 *     strings.
 *  3. An element that never occurs on the other side cannot be part of ANY
 *     common subsequence, so dropping it changes nothing — and it is what
 *     keeps a rewritten region from costing its full size squared.
 */
export function* matchTask(a: readonly string[], b: readonly string[]): Resumable<Array<[number, number]>> {
	const matches: Array<[number, number]> = [];

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		matches.push([start, start]);
		start++;
	}

	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	if (endA > start && endB > start) {
		// Intern: one id per distinct element of the middle region.
		const ids = new Map<string, number>();
		const rawA = new Int32Array(endA - start);
		const rawB = new Int32Array(endB - start);
		let work = 0;
		for (let i = start; i < endA; i++) {
			rawA[i - start] = intern(ids, a[i]);
			if (++work === WORK_PER_PAUSE) {
				work = 0;
				yield;
			}
		}
		for (let i = start; i < endB; i++) {
			rawB[i - start] = intern(ids, b[i]);
			if (++work === WORK_PER_PAUSE) {
				work = 0;
				yield;
			}
		}

		const inA = new Uint8Array(ids.size);
		const inB = new Uint8Array(ids.size);
		for (let i = 0; i < rawA.length; i++) inA[rawA[i]] = 1;
		for (let i = 0; i < rawB.length; i++) inB[rawB[i]] = 1;

		const keptA = keepShared(rawA, inB);
		const keptB = keepShared(rawB, inA);

		if (keptA.values.length > 0 && keptB.values.length > 0) {
			const matchOf = yield* myersMatches(keptA.values, keptB.values);
			for (let p = 0; p < matchOf.length; p++) {
				if (matchOf[p] >= 0) {
					matches.push([start + keptA.origin[p], start + keptB.origin[matchOf[p]]]);
				}
			}
		}
	}

	for (let s = 0; s < a.length - endA; s++) matches.push([endA + s, endB + s]);
	return matches;
}

function intern(ids: Map<string, number>, value: string): number {
	let id = ids.get(value);
	if (id === undefined) {
		id = ids.size;
		ids.set(value, id);
	}
	return id;
}

/** The ids of `seq` that also occur on the other side, with where each came from. */
function keepShared(seq: Int32Array, onOtherSide: Uint8Array): { values: Int32Array; origin: Int32Array } {
	const values = new Int32Array(seq.length);
	const origin = new Int32Array(seq.length);
	let n = 0;
	for (let i = 0; i < seq.length; i++) {
		if (onOtherSide[seq[i]]) {
			values[n] = seq[i];
			origin[n] = i;
			n++;
		}
	}
	return { values: values.subarray(0, n), origin: origin.subarray(0, n) };
}

/**
 * Myers' O((N+M)·D) diff in linear space ("middle snake" divide and conquer),
 * where D is the number of inserted plus deleted elements.
 *
 * Returns, for each index of `a`, the index of `b` it is matched with (or -1).
 * The search itself lives in `MyersSearch.step`, a plain method, because
 * engines do not optimise hot loops inside generator bodies — the same loop
 * written as a generator ran 2.5–5× slower. This wrapper only adds the pauses.
 */
function* myersMatches(a: Int32Array, b: Int32Array): Resumable<Int32Array> {
	const search = new MyersSearch(a, b);
	while (!search.step(WORK_PER_PAUSE)) yield;
	return search.matchOf;
}

/**
 * The search as a resumable state machine. Matches are recorded per index of
 * `a` instead of in emission order, which is what lets the sub-problems live on
 * a plain stack: each one's middle snake depends only on its own range, so the
 * order they are solved in cannot change the result. Only two O(N+M) frontiers
 * are allocated, shared by every sub-problem.
 */
class MyersSearch {
	readonly matchOf: Int32Array;
	private readonly vf: Int32Array;
	private readonly vb: Int32Array;
	private readonly offset: number;
	private readonly stack: number[];

	// The sub-problem being searched, and where its search stands.
	private searching = false;
	private aLo = 0;
	private aHi = 0;
	private bLo = 0;
	private bHi = 0;
	private d = 0;
	private k = 0;
	private backward = false;

	constructor(
		private readonly a: Int32Array,
		private readonly b: Int32Array
	) {
		this.matchOf = new Int32Array(a.length).fill(-1);
		const max = a.length + b.length;
		this.offset = max + 1;
		this.vf = new Int32Array(2 * max + 3);
		this.vb = new Int32Array(2 * max + 3);
		this.stack = [0, a.length, 0, b.length];
	}

	/** Advance by roughly `budget` units of work. True once every match is known. */
	step(budget: number): boolean {
		const { a, b, matchOf, vf, vb, offset, stack } = this;

		for (;;) {
			if (!this.searching) {
				if (stack.length === 0) return true;
				let bHi = stack.pop()!;
				let bLo = stack.pop()!;
				let aHi = stack.pop()!;
				let aLo = stack.pop()!;

				// Shared ends of this range are matched directly.
				while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) matchOf[aLo++] = bLo++;
				while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) matchOf[--aHi] = --bHi;
				if (aLo >= aHi || bLo >= bHi) continue;

				// Both ends differ here, so D ≥ 2 and the middle snake splits the
				// range into two strictly smaller problems.
				this.aLo = aLo;
				this.aHi = aHi;
				this.bLo = bLo;
				this.bHi = bHi;
				this.d = 0;
				this.k = 0;
				this.backward = false;
				this.searching = true;
				vf[offset + 1] = 0;
				vb[offset + 1] = 0;
			}

			const { aLo, aHi, bLo, bHi } = this;
			const n = aHi - aLo;
			const m = bHi - bLo;
			const delta = n - m;
			const odd = (delta & 1) !== 0;
			const limit = Math.ceil((n + m) / 2);
			let d = this.d;
			let k = this.k;
			let backward = this.backward;
			let snake: [number, number, number, number] | null = null;

			search: while (snake === null) {
				if (d > limit) {
					// Unreachable for valid input: the two searches always meet by D/2.
					throw new Error('diff: middle snake not found');
				}

				if (!backward) {
					// Forward: furthest x on each diagonal k = x - y, from the start.
					for (; k <= d; k += 2) {
						let x =
							k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1])
								? vf[offset + k + 1]
								: vf[offset + k - 1] + 1;
						let y = x - k;
						const x0 = x;
						const y0 = y;
						while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
							x++;
							y++;
						}
						vf[offset + k] = x;
						const c = delta - k;
						if (odd && c >= -(d - 1) && c <= d - 1 && x + vb[offset + c] >= n) {
							snake = [aLo + x0, bLo + y0, aLo + x, bLo + y];
							break search;
						}
						budget -= x - x0 + 1;
						if (budget <= 0) {
							this.save(d, k + 2, false);
							return false;
						}
					}
					backward = true;
					k = -d;
				}

				// Backward: the same walk over both ranges reversed.
				for (; k <= d; k += 2) {
					let x =
						k === -d || (k !== d && vb[offset + k - 1] < vb[offset + k + 1])
							? vb[offset + k + 1]
							: vb[offset + k - 1] + 1;
					let y = x - k;
					const x0 = x;
					const y0 = y;
					while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
						x++;
						y++;
					}
					vb[offset + k] = x;
					const c = delta - k;
					if (!odd && c >= -d && c <= d && x + vf[offset + c] >= n) {
						snake = [aLo + n - x, bLo + m - y, aLo + n - x0, bLo + m - y0];
						break search;
					}
					budget -= x - x0 + 1;
					if (budget <= 0) {
						this.save(d, k + 2, true);
						return false;
					}
				}
				d++;
				k = -d;
				backward = false;
			}

			const [x, y, u, v] = snake;
			for (let s = 0; s < u - x; s++) matchOf[x + s] = y + s;
			stack.push(aLo, x, bLo, y, u, aHi, v, bHi);
			this.searching = false;
			if (budget <= 0) return false;
		}
	}

	/**
	 * Where to pick the search up again. `k` may run past `d`; the loop that
	 * resumes it then simply finishes that direction and moves on.
	 */
	private save(d: number, k: number, backward: boolean): void {
		this.d = d;
		this.k = k;
		this.backward = backward;
	}
}

/**
 * Split content into lines
 * Handles different line endings (CRLF, LF)
 */
export function splitLines(content: string): string[] {
	if (!content) return [];
	// Normalize line endings and split
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	// A trailing newline terminates the last line, it does not open a new one.
	// Counting the empty string it leaves behind inflated every added or deleted
	// file by exactly one line — a 2-line new file was reported as +3, which is
	// not what git says and not what the user counts in the editor.
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}
