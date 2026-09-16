/**
 * A dotenv reader that remembers where everything was.
 *
 * `dotenv` and friends answer "what is the value of KEY", which is the wrong
 * question for a writer: updating a variable IN PLACE means knowing which lines
 * held it, whether it was quoted, and whether it was commented out. A parse
 * that returns a plain object throws all of that away and leaves rewriting the
 * file as the only option — which is how tools end up reformatting comments and
 * ordering that the user put there on purpose.
 *
 * Commented assignments are returned too, marked. `.env.example` is often the
 * only record of the variable names a project expects, and half of those files
 * document optional settings as `# REDIS_URL=`, so a detector that ignored
 * comments would miss the shape it exists to find.
 */

/** One `KEY=value`, and where it lives. */
export interface DotenvAssignment {
	key: string;
	value: string;
	/** The original text, including every line the value spans. */
	raw: string;
	/** 0-based index of the first line. */
	line: number;
	/** How many lines the assignment spans — more than one for a quoted value. */
	lineCount: number;
	exported: boolean;
	/** True for `# KEY=value`: documentation, not configuration. */
	commented: boolean;
}

/**
 * `[^\r\n]*` rather than `.*`, and the reason is a bug this had.
 *
 * In JavaScript `.` does not match `\r`, so on a file written on Windows every
 * line ends one character past what `.*$` can reach and the pattern matched
 * NOTHING — a CRLF dotenv file parsed as empty, which would have made detection
 * find no variables and every write append a duplicate.
 */
const ASSIGNMENT = /^(\s*)(#+\s*)?(export\s+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=([^\r\n]*)\r?$/;

/** Decode a double-quoted value's escapes. Single quotes are literal. */
function unescapeDouble(raw: string): string {
	return raw.replace(/\\([nrt"'\\$`])/g, (_match, char: string) => {
		if (char === 'n') return '\n';
		if (char === 'r') return '\r';
		if (char === 't') return '\t';
		return char;
	});
}

/**
 * The index of the quote that closes the value, or -1.
 *
 * Only a double-quoted value honours backslash escapes, which is what every
 * reader in common use does — inside single quotes a backslash is a backslash,
 * so skipping the next character there would read past a legitimate close.
 */
function findClosingQuote(body: string, quote: string): number {
	for (let index = 0; index < body.length; index += 1) {
		if (quote === '"' && body[index] === '\\') {
			index += 1;
			continue;
		}
		if (body[index] === quote) return index;
	}
	return -1;
}

/**
 * Read a value that may run past the end of its first line.
 *
 * Returns how many EXTRA lines were consumed so the caller can keep its own
 * line index honest — the whole reason this module exists.
 */
function readValue(
	first: string,
	lines: string[],
	index: number
): { value: string; extraLines: number } {
	const trimmed = first.trimStart();
	const quote = trimmed[0];

	if (quote !== '"' && quote !== "'" && quote !== '`') {
		// Unquoted. Everything from an unescaped `#` onwards is a comment, which
		// is what every reader in common use does.
		const withoutComment = trimmed.split('#')[0] ?? '';
		return { value: withoutComment.trim(), extraLines: 0 };
	}

	let body = trimmed.slice(1);
	let extraLines = 0;

	for (;;) {
		const closing = findClosingQuote(body, quote);
		if (closing !== -1) {
			const inner = body.slice(0, closing);
			return { value: quote === '"' ? unescapeDouble(inner) : inner, extraLines };
		}

		const next = lines[index + extraLines + 1];
		// Unterminated at end of file. Taking what there is beats discarding the
		// assignment: the caller is deciding whether to rewrite this line, and a
		// key it cannot see is a key it would append a duplicate of.
		if (next === undefined) {
			return { value: quote === '"' ? unescapeDouble(body) : body, extraLines };
		}
		body = `${body}\n${next}`;
		extraLines += 1;
	}
}

export function parseDotenv(content: string): DotenvAssignment[] {
	const lines = content.split('\n');
	const found: DotenvAssignment[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const match = ASSIGNMENT.exec(lines[index]);
		if (!match) continue;

		const [, , hash, exported, key, rest] = match;
		const { value, extraLines } = readValue(rest, lines, index);
		const lineCount = extraLines + 1;

		found.push({
			key,
			value,
			raw: lines.slice(index, index + lineCount).join('\n'),
			line: index,
			lineCount,
			exported: Boolean(exported),
			commented: Boolean(hash)
		});

		index += extraLines;
	}

	return found;
}

/**
 * The assignment a reader would actually use for `key`, or null.
 *
 * The LAST one wins, and commented ones do not count — the two rules that
 * decide whether writing a variable will have any effect.
 */
export function effectiveAssignment(
	assignments: DotenvAssignment[],
	key: string
): DotenvAssignment | null {
	let winner: DotenvAssignment | null = null;
	for (const assignment of assignments) {
		if (assignment.commented) continue;
		if (assignment.key === key) winner = assignment;
	}
	return winner;
}
