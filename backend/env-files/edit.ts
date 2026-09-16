/**
 * Editing a dotenv file without rewriting it.
 *
 * **In place**, when the project already assigns the variable. The value is
 * replaced exactly where it was, so the file keeps the shape its author gave
 * it, and the previous value is left behind as a comment — the whole point of
 * touching someone's configuration is that they can get it back. This is the
 * mode that answers "my project calls it `POSTGRES_URL`, not `DATABASE_URL`":
 * nothing is guessed, the existing key is what gets written.
 *
 * **Appended**, plainly, for a variable the file does not have yet.
 *
 * NO MARKED BLOCK, and there used to be one. It existed to tell Clopen's lines
 * from the user's so that undoing could not delete a variable they wrote — but
 * it cost three lines of scaffolding around one value, and worse, a block that
 * has to come LAST leaves the project's own `DATABASE_URL` sitting untouched
 * above it. A reader takes the last assignment, so the file WORKS and looks
 * like it does not, which is the least defensible thing a config editor can do.
 *
 * Removal keeps the guarantee more cheaply. A replaced value is restored from
 * the comment left beside it, and an appended key is removed only while it
 * still holds exactly what was written — anything else is the user's and stays.
 *
 * Backups do not stack. A second apply removes the comment the first one left
 * for the same key before writing a new one, or a file rewritten weekly would
 * grow a dead line per week.
 */

import { formatEnvLine } from './keys';
import { effectiveAssignment, parseDotenv } from './parse';

/** Marks the line holding a value Clopen replaced, so it can be put back. */
export const PREVIOUS_VALUE_PREFIX = '# clopen:previous ';

export interface EnvUpsertOptions {
	/** A comment written above the appended lines, naming where they came from. */
	note?: string;
}

export interface EnvUpsertResult {
	text: string;
	/** Keys whose existing assignment was rewritten where it stood. */
	updated: string[];
	/** Keys the file did not have, now in the managed block. */
	appended: string[];
	/** Keys already holding exactly this value. */
	unchanged: string[];
}

/** The key a `# clopen:previous …` line is a backup of, or null. */
function keyOfBackup(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith(PREVIOUS_VALUE_PREFIX)) return null;
	const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(
		trimmed.slice(PREVIOUS_VALUE_PREFIX.length)
	);
	return match ? match[1] : null;
}

/**
 * Whether this file uses Windows line endings.
 *
 * Everything below works in LF and converts back at the end, so a file written
 * on Windows keeps its own convention instead of gaining one mixed line per
 * variable Clopen touches.
 */
function usesCrlf(content: string): boolean {
	return /\r\n/.test(content);
}

export function upsertEnvKeys(
	content: string,
	vars: Record<string, string>,
	options: EnvUpsertOptions = {}
): EnvUpsertResult {
	const keys = Object.keys(vars);
	const crlf = usesCrlf(content);
	if (crlf) content = content.replace(/\r\n/g, '\n');

	// Our own backup comments for the keys being written come out first, so this
	// apply replaces them rather than adding a second one. Backups for keys NOT
	// in this write are left alone — they still document a value we replaced.
	const base = content
		.split('\n')
		.filter((line) => {
			const key = keyOfBackup(line);
			return !(key !== null && keys.includes(key));
		})
		.join('\n');

	const assignments = parseDotenv(base);
	const lines = base.split('\n');

	const updated: string[] = [];
	const appended: string[] = [];
	const unchanged: string[] = [];
	/** Keys bound for the block, whether or not their value changed. */
	const placed: string[] = [];
	const edits: { line: number; lineCount: number; replacement: string[] }[] = [];

	for (const key of keys) {
		const value = vars[key];
		const existing = effectiveAssignment(assignments, key);

		if (!existing) {
			placed.push(key);
			appended.push(key);
			continue;
		}
		if (existing.value === value) {
			unchanged.push(key);
			continue;
		}

		edits.push({
			line: existing.line,
			lineCount: existing.lineCount,
			replacement: [
				// Folded to one line. A multi-line quoted value would otherwise
				// become several comment lines, only the first of which is a comment.
				`${PREVIOUS_VALUE_PREFIX}${existing.raw.split('\n').join(' ')}`,
				formatEnvLine(key, value)
			]
		});
		updated.push(key);
	}

	// Back to front, so every line index recorded above stays valid.
	for (const edit of edits.sort((a, b) => b.line - a.line)) {
		lines.splice(edit.line, edit.lineCount, ...edit.replacement);
	}

	const added =
		placed.length > 0
			? [
				...(options.note ? [`# ${options.note}`] : []),
				...placed.map((key) => formatEnvLine(key, vars[key]))
			]
			: [];

	const text = appendPlainLines(lines.join('\n'), added);

	return {
		text: crlf ? text.replace(/\n/g, '\r\n') : text,
		updated,
		appended,
		unchanged
	};
}

/**
 * Add lines to the end of a file, with no markers around them.
 *
 * One blank line between the user's content and ours, and none when the file
 * was empty — which is what someone appending by hand would do.
 */
function appendPlainLines(existing: string, lines: string[]): string {
	if (lines.length === 0) return existing;
	const block = `${lines.join('\n')}\n`;
	if (!existing.trim()) return block;
	return `${existing.replace(/\n*$/, '')}\n\n${block}`;
}

/**
 * Take the write back out.
 *
 * The managed block goes entirely, and every value replaced in place is
 * restored from the comment left beside it. A key with no backup is LEFT
 * ALONE rather than deleted: it was the project's own variable before Clopen
 * touched it, and removing a variable the app needs is worse than leaving one
 * pointing at a database the user can still reach.
 */
export function removeEnvKeys(
	content: string,
	keys: string[],
	options: { values?: Record<string, string> } = {}
): string {
	const crlf = usesCrlf(content);
	const lines = (crlf ? content.replace(/\r\n/g, '\n') : content).split('\n');

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const key = keyOfBackup(lines[index]);
		if (key === null || !keys.includes(key)) continue;

		const original = lines[index].trim().slice(PREVIOUS_VALUE_PREFIX.length);
		// The line we wrote sits directly below its backup. When it does not, the
		// user has edited it since, and their line is the one that stays.
		const next = lines[index + 1] ?? '';
		const ours = new RegExp(`^\\s*(?:export\\s+)?${key}[ \\t]*=`).test(next);
		lines.splice(index, ours ? 2 : 1, original);
	}

	// Keys that were APPENDED have no backup to restore, so they are removed —
	// but only while they still hold exactly what was written. A value the user
	// has since edited is theirs now, and deleting it would be this feature
	// taking away a variable it did not put there.
	if (options.values) {
		const ours = parseDotenv(lines.join('\n')).filter(
			(entry) =>
				!entry.commented &&
				keys.includes(entry.key) &&
				options.values?.[entry.key] === entry.value
		);
		// Back to front, so every recorded position stays valid.
		for (const entry of ours.reverse()) lines.splice(entry.line, entry.lineCount);
		// The blank line that separated the appended lines from the user's own
		// content has nothing left to separate.
		while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '') lines.pop();
	}

	const text = lines.join('\n');
	return crlf ? text.replace(/\n/g, '\r\n') : text;
}
