/**
 * A unified patch, split back into the two files it describes.
 *
 * A provider hands over one `@@` patch per file; a diff EDITOR wants the two
 * sides. Splitting is what lets the Issues & PRs surface render a pull request
 * through the same Monaco diff the Git panel uses, instead of colouring patch
 * lines by their leading character — which cannot align two columns, and is
 * what made the split view collide with itself.
 *
 * Only the hunks the provider sent are reconstructed, so the sides are the
 * changed regions rather than the whole files. The real line numbers travel
 * alongside them, so the gutter still reads like the file even though the
 * unchanged stretches between hunks are absent.
 */

export interface PatchSides {
	original: string;
	modified: string;
	/** Real line number per rendered line, 0 where the side has no line. */
	originalLineNumbers: number[];
	modifiedLineNumbers: number[];
	/** No hunks — a binary file, or a patch the provider withheld. */
	isEmpty: boolean;
}

const EMPTY: PatchSides = {
	original: '',
	modified: '',
	originalLineNumbers: [],
	modifiedLineNumbers: [],
	isEmpty: true
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function splitUnifiedPatch(patch: string | undefined | null): PatchSides {
	if (!patch) return EMPTY;

	const original: string[] = [];
	const modified: string[] = [];
	const originalLineNumbers: number[] = [];
	const modifiedLineNumbers: number[] = [];

	let oldLine = 0;
	let newLine = 0;
	let sawHunk = false;

	for (const line of patch.split('\n')) {
		const header = HUNK.exec(line);
		if (header) {
			sawHunk = true;
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			continue;
		}
		if (!sawHunk) continue;
		// "\ No newline at end of file" annotates the line above it rather than
		// being a line of either file.
		if (line.startsWith('\\')) continue;

		const marker = line[0] ?? ' ';
		const content = line.slice(1);

		if (marker === '+') {
			modified.push(content);
			modifiedLineNumbers.push(newLine++);
		} else if (marker === '-') {
			original.push(content);
			originalLineNumbers.push(oldLine++);
		} else {
			original.push(content);
			originalLineNumbers.push(oldLine++);
			modified.push(content);
			modifiedLineNumbers.push(newLine++);
		}
	}

	if (!sawHunk) return EMPTY;

	return {
		original: original.join('\n'),
		modified: modified.join('\n'),
		originalLineNumbers,
		modifiedLineNumbers,
		isEmpty: original.length === 0 && modified.length === 0
	};
}
