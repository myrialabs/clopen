/**
 * `@3` in a message names its third attachment.
 *
 * Attachments are numbered per message, from 1, in the order they were
 * attached. The composer shows the numbers on its cards, the sent message shows
 * them on its own, and the prompt labels every file with the same token — so
 * "compare @1 with @3" means the same two files to the user and to the model.
 */

/**
 * A token stands on its own: at the start, or after whitespace or an opening
 * bracket or quote (so `me@2x.com` is not one), and not running on into a
 * word (so `@2x` is not one either).
 */
const MENTION = /(^|[\s([{"'“‘])@(\d{1,4})(?![\w@])/g;

export function mentionToken(index: number): string {
	return `@${index}`;
}

/** The attachment numbers a text mentions, in order of first appearance. */
export function mentionedIndexes(text: string): number[] {
	const seen = new Set<number>();
	for (const match of text.matchAll(MENTION)) seen.add(Number(match[2]));
	return [...seen];
}

/**
 * Rewrite every token. `replace` returns the new number, a replacement text,
 * or null to leave the token as it is.
 */
export function rewriteMentions(text: string, replace: (index: number) => number | string | null): string {
	return text.replace(MENTION, (whole, lead: string, digits: string) => {
		const next = replace(Number(digits));
		if (next === null) return whole;
		return lead + (typeof next === 'number' ? mentionToken(next) : next);
	});
}

/** Stands in for a token being deleted, until the space around it is tidied. */
const DROPPED = '\u0000';

/**
 * Rewrite tokens, deleting the ones `next` answers `false` for together with
 * the space they leave: "compare @1 with @2" without @2 reads "compare @1
 * with", not "compare @1 with ".
 */
function rewriteDropping(text: string, next: (index: number) => number | false | null): string {
	const marked = rewriteMentions(text, (index) => {
		const answer = next(index);
		return answer === false ? DROPPED : answer;
	});
	if (!marked.includes(DROPPED)) return marked;
	return marked.replace(/[ \t]*\u0000[ \t]*/g, (match: string, offset: number, whole: string) => {
		const before = whole[offset - 1];
		const after = whole[offset + match.length];
		// Between two words one space stays; at the edge of a line, none.
		const between = before !== undefined && before !== '\n' && after !== undefined && after !== '\n';
		return between && /^[ \t]/.test(match) && /[ \t]$/.test(match) ? ' ' : '';
	});
}

/**
 * The text after attachment `removed` (1-based) is taken out of `count`: its
 * own tokens are deleted — the file is gone, and so is the reference — and
 * later numbers move down one.
 */
export function removeMention(text: string, removed: number, count: number): string {
	return rewriteDropping(text, (index) => {
		if (index === removed) return false;
		return index > removed && index <= count ? index - 1 : null;
	});
}

/** Every token naming one of `count` attachments, deleted — they were all removed. */
export function removeAllMentions(text: string, count: number): string {
	return rewriteDropping(text, (index) => (index >= 1 && index <= count ? false : null));
}

/** Text written against its own attachments, appended after `offset` others. */
export function shiftMentions(text: string, offset: number, count: number): string {
	if (offset === 0) return text;
	return rewriteMentions(text, (index) => (index >= 1 && index <= count ? index + offset : null));
}

/** Split a text around the tokens that name one of `count` attachments. */
export function splitMentions(text: string, count: number): Array<string | number> {
	const parts: Array<string | number> = [];
	let last = 0;
	for (const match of text.matchAll(MENTION)) {
		const index = Number(match[2]);
		if (index < 1 || index > count) continue;
		const start = (match.index ?? 0) + match[1].length;
		if (start > last) parts.push(text.slice(last, start));
		parts.push(index);
		last = start + match[0].length - match[1].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}
