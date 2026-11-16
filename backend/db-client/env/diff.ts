/**
 * A line diff small enough to read inside a panel.
 *
 * Exists because applying this feature EDITS SOMEONE'S CONFIGURATION FILE, and
 * the only version of that which is defensible is one where they see the change
 * first. The edit script is the shared engine in `shared/utils/diff-calculator`,
 * the same exact diff behind every other diff and +/- count in the app.
 *
 * Unchanged runs are collapsed to an ellipsis rather than dropped silently: a
 * dotenv file can hold thirty unrelated variables, and a preview that showed
 * all of them would bury the two lines that matter — but one that quietly
 * omitted them would read as "this is the whole file".
 */

import type { DbEnvDiffLine } from '$shared/types/db-client';
import { diffSequencesAsync } from '$shared/utils/diff-calculator';

/** How many unchanged lines to keep on each side of a change. */
const CONTEXT = 2;

export async function diffLines(before: string, after: string, context = CONTEXT): Promise<DbEnvDiffLine[]> {
	const a = before === '' ? [] : before.split('\n');
	const b = after === '' ? [] : after.split('\n');

	const full: DbEnvDiffLine[] = (await diffSequencesAsync(a, b)).map((op): DbEnvDiffLine => {
		if (op.type === 'keep') return { kind: 'context', text: a[op.oldIndex] };
		if (op.type === 'delete') return { kind: 'removed', text: a[op.oldIndex] };
		return { kind: 'added', text: b[op.newIndex] };
	});

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
