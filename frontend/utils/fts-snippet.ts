/**
 * Shared parser for FTS5 snippet() output.
 * Backend wraps matches in char(1)/char(2) sentinels (see session-queries.ts
 * searchGlobal / searchByMessageContent) — this splits them into plain/
 * highlighted segments so callers can render safely (no {@html}, since the
 * snippet is user-authored chat content).
 */

const SNIPPET_MATCH_START = String.fromCharCode(1);
const SNIPPET_MATCH_END = String.fromCharCode(2);

export interface SnippetPart {
	text: string;
	hl: boolean;
}

export function parseSnippet(snippet: string): SnippetPart[] {
	const parts: SnippetPart[] = [];
	let cursor = 0;
	while (cursor < snippet.length) {
		const start = snippet.indexOf(SNIPPET_MATCH_START, cursor);
		if (start === -1) {
			parts.push({ text: snippet.slice(cursor), hl: false });
			break;
		}
		if (start > cursor) parts.push({ text: snippet.slice(cursor, start), hl: false });

		const end = snippet.indexOf(SNIPPET_MATCH_END, start + 1);
		if (end === -1) {
			parts.push({ text: snippet.slice(start + 1), hl: true });
			break;
		}
		parts.push({ text: snippet.slice(start + 1, end), hl: true });
		cursor = end + 1;
	}
	return parts;
}
