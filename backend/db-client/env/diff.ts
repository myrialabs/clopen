/**
 * A line diff small enough to read inside a panel.
 *
 * Exists because applying this feature EDITS SOMEONE'S CONFIGURATION FILE, and
 * the only version of that which is defensible is one where they see the change
 * first. `shared/utils/diff-calculator` counts lines for checkpoint stats and
 * never produces the lines themselves, so there was nothing to reuse.
 *
 * Unchanged runs are collapsed to an ellipsis rather than dropped silently: a
 * dotenv file can hold thirty unrelated variables, and a preview that showed
 * all of them would bury the two lines that matter — but one that quietly
 * omitted them would read as "this is the whole file".
 */

import type { DbEnvDiffLine } from '$shared/types/db-client';

/** How many unchanged lines to keep on each side of a change. */
const CONTEXT = 2;

export function diffLines(before: string, after: string, context = CONTEXT): DbEnvDiffLine[] {
	const a = before === '' ? [] : before.split('\n');
	const b = after === '' ? [] : after.split('\n');

	// Longest common subsequence. Both sides are one dotenv file, so the table
	// is at worst a few hundred squared — small enough that the simple algorithm
	// is the right one.
	const table: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const full: DbEnvDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			full.push({ kind: 'context', text: a[i] });
			i += 1;
			j += 1;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			full.push({ kind: 'removed', text: a[i] });
			i += 1;
		} else {
			full.push({ kind: 'added', text: b[j] });
			j += 1;
		}
	}
	for (; i < a.length; i += 1) full.push({ kind: 'removed', text: a[i] });
	for (; j < b.length; j += 1) full.push({ kind: 'added', text: b[j] });

	// A file's final newline shows up as a blank line gained or lost, which is
	// not a change anyone means. Left in, it rendered as a lone `+` under every
	// preview.
	while (full.length > 0 && full.at(-1)!.text === '' && full.at(-1)!.kind !== 'context') {
		full.pop();
	}
	// No change at all is an EMPTY diff, not one ellipsis standing in for the
	// whole file — an empty region reads as "nothing to show", an ellipsis reads
	// as "something is hidden here".
	if (!full.some((line) => line.kind !== 'context')) return [];

	return collapse(full, context);
}

function collapse(lines: DbEnvDiffLine[], context: number): DbEnvDiffLine[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.kind === 'context') return;
		for (let offset = -context; offset <= context; offset += 1) {
			const target = index + offset;
			if (target >= 0 && target < lines.length) keep[target] = true;
		}
	});

	const result: DbEnvDiffLine[] = [];
	let skipping = false;
	lines.forEach((line, index) => {
		if (keep[index]) {
			result.push(line);
			skipping = false;
			return;
		}
		if (!skipping) {
			result.push({ kind: 'context', text: '…' });
			skipping = true;
		}
	});

	return result;
}
