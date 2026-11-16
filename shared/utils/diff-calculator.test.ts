/**
 * Line counting for +/- badges.
 *
 * These numbers sit next to a file name in the checkpoint timeline, the
 * Changes tab and every Edit tool row, where they are read against what git
 * says about the same file. A file that ends with a newline — which is most
 * source files — used to count one line more than it has, so the badges and
 * git disagreed on every created and deleted file.
 */

import { describe, test, expect } from 'bun:test';

import {
	countLineChanges,
	countLineChangesAsync,
	countLineChangesTask,
	countCommon,
	diffSequences,
	isBinaryBuffer,
	runSliced,
	runToEnd
} from './diff-calculator';

describe('countLineChanges', () => {
	test('counts a created file by its real lines, trailing newline and all', () => {
		expect(countLineChanges('', 'one\ntwo\n')).toEqual({ additions: 2, deletions: 0 });
	});

	test('counts a file with no trailing newline the same way', () => {
		expect(countLineChanges('', 'one\ntwo')).toEqual({ additions: 2, deletions: 0 });
	});

	test('counts a deleted file as deletions only', () => {
		expect(countLineChanges('one\ntwo\nthree\n', '')).toEqual({ additions: 0, deletions: 3 });
	});

	test('counts only the lines that actually moved, not the context around them', () => {
		expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ additions: 1, deletions: 1 });
	});

	test('reads CRLF as the same content as LF', () => {
		expect(countLineChanges('a\r\nb\r\n', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 });
	});

	test('answers nothing for two empty sides', () => {
		expect(countLineChanges('', '')).toEqual({ additions: 0, deletions: 0 });
	});
});

describe('isBinaryBuffer', () => {
	test('calls a NUL byte binary and plain text not', () => {
		expect(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x00, 0x0a]))).toBe(true);
		expect(isBinaryBuffer(Buffer.from('a\nb\n', 'utf8'))).toBe(false);
	});
});

/** The textbook O(old×new) LCS table — the reference the fast count must equal. */
function referenceCounts(oldContent: string, newContent: string): { additions: number; deletions: number } {
	const split = (text: string) => {
		if (!text) return [];
		const lines = text.replace(/\r\n/g, '\n').split('\n');
		if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
		return lines;
	};
	const a = split(oldContent);
	const b = split(newContent);
	const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	const common = dp[a.length][b.length];
	return { additions: b.length - common, deletions: a.length - common };
}

/** Deterministic PRNG so a failure reproduces. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

/** Replay an edit script: it must consume all of `a` and produce exactly `b`. */
function applyScript(a: string[], b: string[]): string[] {
	const out: string[] = [];
	let consumed = 0;
	for (const op of diffSequences(a, b)) {
		if (op.type === 'keep') {
			expect(a[op.oldIndex]).toBe(b[op.newIndex]);
			out.push(b[op.newIndex]);
			consumed++;
		} else if (op.type === 'insert') {
			out.push(b[op.newIndex]);
		} else {
			consumed++;
		}
	}
	expect(consumed).toBe(a.length);
	return out;
}

describe('diffSequences', () => {
	test('produces a script that turns one side into the other, minimally', () => {
		const random = seeded(7);
		for (let round = 0; round < 2000; round++) {
			const alphabetSize = 1 + Math.floor(random() * 6);
			const make = (length: number) =>
				Array.from({ length }, () => String(Math.floor(random() * alphabetSize)));
			const a = make(Math.floor(random() * 30));
			const b = random() < 0.5 ? make(Math.floor(random() * 30)) : a.filter(() => random() > 0.3);

			expect(applyScript(a, b)).toEqual(b);
			const kept = diffSequences(a, b).filter((op) => op.type === 'keep').length;
			const reference = referenceCounts(a.join('\n'), b.join('\n'));
			expect(kept).toBe(b.length - reference.additions);
			expect(countCommon(a, b)).toBe(kept);
		}
	});

	test('puts deletions before insertions inside a changed region', () => {
		expect(diffSequences(['a', 'x', 'c'], ['a', 'y', 'c']).map((op) => op.type)).toEqual([
			'keep',
			'delete',
			'insert',
			'keep'
		]);
	});
});

describe('countLineChanges exactness', () => {
	test('matches the full LCS table on random edits, including repeated lines', () => {
		const random = seeded(42);
		// A small alphabet forces repeats, which is where a shortcut would go wrong.
		const alphabet = ['}', '', 'a', 'b', 'c', 'return x;', '{', 'd'];
		const pick = () => alphabet[Math.floor(random() * alphabet.length)];

		for (let round = 0; round < 400; round++) {
			const oldLines = Array.from({ length: Math.floor(random() * 40) }, pick);
			const newLines = oldLines.filter(() => random() > 0.2);
			for (let i = 0; i < Math.floor(random() * 10); i++) {
				newLines.splice(Math.floor(random() * (newLines.length + 1)), 0, pick());
			}
			const oldText = oldLines.join('\n');
			const newText = newLines.join('\n');
			expect(countLineChanges(oldText, newText)).toEqual(referenceCounts(oldText, newText));
		}
	});

	test('counts a full rewrite as every line out and every line in', () => {
		expect(countLineChanges('a\nb\nc\n', 'x\ny\n')).toEqual({ additions: 2, deletions: 3 });
	});
});

describe('countLineChanges on large files', () => {
	test('counts a small edit to a huge file without an old×new table', () => {
		// The shape that froze the server: a ~47k-line generated catalog that grew
		// by a few hundred lines. The old table needed ~2.3 billion cells here.
		const base = Array.from({ length: 47_000 }, (_, i) => `  "key_${i}" : { "value" : "${i}" },`);
		const grown = [...base];
		for (let i = 0; i < 300; i++) grown.splice(i * 150, 0, `  "new_${i}" : { "value" : "n" },`);

		const started = performance.now();
		const counts = countLineChanges(base.join('\n'), grown.join('\n'));
		const elapsed = performance.now() - started;

		expect(counts).toEqual({ additions: 300, deletions: 0 });
		expect(elapsed).toBeLessThan(2000);
	});

	test('counts a rewritten region of a large file exactly', () => {
		const head = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
		const oldText = [...head, ...Array.from({ length: 2_000 }, (_, i) => `old ${i}`)].join('\n');
		const newText = [...head, ...Array.from({ length: 1_500 }, (_, i) => `new ${i}`)].join('\n');

		expect(countLineChanges(oldText, newText)).toEqual({ additions: 1_500, deletions: 2_000 });
	});
});

describe('runSliced', () => {
	/** A reversed run of repeated lines: the slow shape for any exact diff. */
	const reversedRepeats = (size: number) => {
		const lines = Array.from({ length: size }, (_, i) => `line ${i % 40}`);
		return [lines.join('\n'), [...lines].reverse().join('\n')] as const;
	};

	test('answers exactly what the synchronous driver answers', async () => {
		const [before, after] = reversedRepeats(3_000);
		expect(await runSliced(countLineChangesTask(before, after))).toEqual(
			runToEnd(countLineChangesTask(before, after))
		);
	});

	test('keeps the event loop turning while a slow diff runs', async () => {
		// This is the property the server relies on: a pathological pair takes
		// long, but timers (and sockets) are still served every few milliseconds.
		const [before, after] = reversedRepeats(12_000);
		let last = performance.now();
		let longestGap = 0;
		let ticks = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			longestGap = Math.max(longestGap, now - last);
			last = now;
			ticks++;
		}, 1);

		const started = performance.now();
		await countLineChangesAsync(before, after);
		const elapsed = performance.now() - started;
		clearInterval(timer);

		expect(elapsed).toBeGreaterThan(100);
		expect(ticks).toBeGreaterThan(5);
		expect(longestGap).toBeLessThan(100);
	});

	test('stops when its signal is aborted', async () => {
		const [before, after] = reversedRepeats(12_000);
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error('no longer wanted')), 20);
		await expect(countLineChangesAsync(before, after, controller.signal)).rejects.toThrow('no longer wanted');
	});
});
