/**
 * Replace a block of lines in a file's text, but only if it still reads as
 * expected.
 *
 * This is how the Git panel discards one change on disk and puts it back: the
 * diff says "at line N these lines became those", and the edit swaps them
 * back. Done on the text rather than through `git apply`, which needs a
 * byte-exact patch — a file without a final newline or with CRLF endings made
 * a zero-context patch fail. Line endings are preserved line by line, and the
 * block is checked before it is touched: if the file moved on since the diff
 * was read, the edit is refused instead of landing on the wrong lines.
 */

export interface LineEdit {
	/** 1-based line the block starts on (for a pure insertion: where it goes). */
	start: number;
	/** Lines expected at `start`, which the edit takes out. */
	remove: string[];
	/** Lines the edit puts in their place. */
	insert: string[];
}

export class LineEditConflictError extends Error {
	constructor() {
		super('The file changed since this diff was loaded.');
		this.name = 'LineEditConflictError';
	}
}

const stripCr = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

export function applyLineEdit(text: string, edit: LineEdit): string {
	// Split on \n only, so each line keeps its own \r and lines the edit does
	// not touch come back byte for byte.
	const lines = text.split('\n');
	const usesCrlf = text.includes('\r\n');
	const at = edit.start - 1;

	if (at < 0 || at > lines.length) throw new LineEditConflictError();
	for (let i = 0; i < edit.remove.length; i++) {
		const current = lines[at + i];
		if (current === undefined || stripCr(current) !== stripCr(edit.remove[i])) {
			throw new LineEditConflictError();
		}
	}

	const inserted = edit.insert.map((line) => {
		const bare = stripCr(line);
		return usesCrlf ? `${bare}\r` : bare;
	});
	// A block that ran to the very end of a file with no final newline: the
	// last remaining line keeps that shape too.
	if (inserted.length > 0 && at + edit.remove.length >= lines.length) {
		inserted[inserted.length - 1] = stripCr(inserted[inserted.length - 1]);
		// Appending past that last line gives it the line break it now needs.
		if (at === lines.length && at > 0 && usesCrlf) lines[at - 1] = `${stripCr(lines[at - 1])}\r`;
	}
	lines.splice(at, edit.remove.length, ...inserted);
	return lines.join('\n');
}

/** The edit that puts back what `edit` changed. */
export function invertLineEdit(edit: LineEdit): LineEdit {
	return { start: edit.start, remove: edit.insert, insert: edit.remove };
}
