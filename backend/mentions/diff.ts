/**
 * Unified diffs of two texts, for snapshots that are not in git — the
 * checkpoint blobs the AI-changes view reads.
 */

import { diffSequencesAsync, splitLines, type DiffOp } from '$shared/utils/diff-calculator';

const CONTEXT = 3;

/** A `diff -u` style diff of `before` → `after`, or '' when they are the same. */
export async function unifiedDiff(path: string, before: string, after: string): Promise<string> {
	if (before === after) return '';
	const a = splitLines(before);
	const b = splitLines(after);
	const ops = await diffSequencesAsync(a, b);

	// Lines of the edit script, each with where it sits on either side.
	type Line = { op: DiffOp['type']; text: string; oldLine: number; newLine: number };
	const lines: Line[] = [];
	let oldLine = 0;
	let newLine = 0;
	for (const op of ops) {
		if (op.type === 'keep') lines.push({ op: 'keep', text: a[op.oldIndex], oldLine: ++oldLine, newLine: ++newLine });
		else if (op.type === 'delete') lines.push({ op: 'delete', text: a[op.oldIndex], oldLine: ++oldLine, newLine });
		else lines.push({ op: 'insert', text: b[op.newIndex], oldLine, newLine: ++newLine });
	}

	const header = [`--- ${before ? `a/${path}` : '/dev/null'}`, `+++ ${after ? `b/${path}` : '/dev/null'}`];
	const hunks: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].op === 'keep') {
			i++;
			continue;
		}
		const start = Math.max(0, i - CONTEXT);
		let end = i;
		// Extend while changes are within two contexts of each other.
		while (end < lines.length) {
			if (lines[end].op !== 'keep') {
				end++;
				continue;
			}
			let next = end;
			while (next < lines.length && lines[next].op === 'keep') next++;
			if (next < lines.length && next - end <= CONTEXT * 2) end = next;
			else break;
		}
		const stop = Math.min(lines.length, end + CONTEXT);
		const slice = lines.slice(start, stop);
		const first = slice[0];
		const oldStart = first.op === 'insert' ? first.oldLine + 1 : first.oldLine;
		const newStart = first.op === 'delete' ? first.newLine + 1 : first.newLine;
		const oldCount = slice.filter((line) => line.op !== 'insert').length;
		const newCount = slice.filter((line) => line.op !== 'delete').length;
		hunks.push(
			`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`,
			...slice.map((line) => `${line.op === 'keep' ? ' ' : line.op === 'delete' ? '-' : '+'}${line.text}`)
		);
		i = stop;
	}
	return [...header, ...hunks].join('\n');
}
