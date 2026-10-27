/**
 * "The next thing you type is for this." A chat has no text field next to a
 * button, so when a button needs words (a question's "Other…", a new folder's
 * name), the bot asks and the chat's NEXT plain message is the answer,
 * instead of a prompt for the session. Replying to the asking message works
 * too, and is the only way once something newer was asked.
 *
 * One per chat, newest wins, and it lapses: a message typed an hour later is
 * a message, not a late answer. A command clears it.
 */

export type Awaiting = { kind: 'question'; rowId: string } | { kind: 'ask'; rowId: string };

const AWAIT_TTL_MS = 10 * 60 * 1000;

const awaiting = new Map<string, Awaiting & { at: number }>();

export function setAwaiting(linkId: string, entry: Awaiting): void {
	awaiting.set(linkId, { ...entry, at: Date.now() });
}

/** What the chat's next plain message answers, if anything. Asking consumes it. */
export function takeAwaiting(linkId: string): Awaiting | null {
	const entry = awaiting.get(linkId);
	awaiting.delete(linkId);
	if (!entry || Date.now() - entry.at > AWAIT_TTL_MS) return null;
	return entry.kind === 'question' ? { kind: 'question', rowId: entry.rowId } : { kind: 'ask', rowId: entry.rowId };
}

/** Is the chat waiting to type into this row? */
export function isAwaiting(linkId: string, rowId: string): boolean {
	const entry = awaiting.get(linkId);
	return Boolean(entry && entry.rowId === rowId && Date.now() - entry.at <= AWAIT_TTL_MS);
}

/** Is the chat waiting for typed words at all? */
export function hasAwaiting(linkId: string): boolean {
	const entry = awaiting.get(linkId);
	return Boolean(entry && Date.now() - entry.at <= AWAIT_TTL_MS);
}

export function clearAwaiting(linkId: string): void {
	awaiting.delete(linkId);
}

/** Tests only. */
export function resetAwaiting(): void {
	awaiting.clear();
}
