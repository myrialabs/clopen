/**
 * Indexing a chat's turns by file path, and deciding what the marker says.
 *
 * Kept free of runes and stores so the rules that the Files dot, the Git dot
 * and the Changes tab all obey can be tested directly — the parts that used to
 * disagree with each other were exactly the parts nothing could assert on.
 */

export type TurnFileStatus = 'added' | 'modified' | 'deleted';

/** One file changed by one turn. Mirrors the backend's TurnFileChange. */
export interface TurnFileChange {
	/** Project-relative path with forward slashes. */
	path: string;
	status: TurnFileStatus;
	insertions: number;
	deletions: number;
	isBinary: boolean;
	/** False when the blob backing one side is gone, so no diff can be shown. */
	contentAvailable: boolean;
}

/** One turn of the conversation and everything it changed. */
export interface TurnChanges {
	/** Checkpoint message id, or null for the turn that is still running. */
	checkpointMessageId: string | null;
	/** 1-based position on the active path. Null while the turn is in flight. */
	turnIndex: number | null;
	timestamp: string;
	promptText: string;
	files: TurnFileChange[];
}

/** Everything known about one path across the whole conversation. */
export interface PathChanges {
	/** Absolute path, matching what the file tree and git status use as keys. */
	absolutePath: string;
	relativePath: string;
	/** Turns that touched it, newest first. */
	turns: TurnChanges[];
	/** Status from the most recent turn that touched it. */
	latestStatus: TurnFileStatus;
	/** True when the still-running turn is one of them. */
	isPending: boolean;
}

/**
 * `live` — the change is still sitting in the working tree, unreviewed.
 * `settled` — it has been staged or committed since.
 * `null` — this chat did not touch the file.
 */
export type AiMarkerState = 'live' | 'settled' | null;

/** The in-flight turn's synthetic id, so it can be selected like any other. */
export const PENDING_TURN_ID = '__pending__';

/** Stable id for a turn, usable as a key and in a request. */
export function turnIdOf(turn: TurnChanges): string {
	return turn.checkpointMessageId ?? PENDING_TURN_ID;
}

/** Join a project root and a relative path with the root's own separator. */
export function toAbsolutePath(root: string, relativePath: string): string {
	const separator = root.includes('\\') ? '\\' : '/';
	const rel = separator === '\\' ? relativePath.replace(/\//g, '\\') : relativePath;
	return `${root}${separator}${rel}`;
}

/**
 * Build the path lookup the panels use. `turns` must already be newest-first,
 * which is the order the backend returns and the order every consumer assumes.
 */
export function indexTurnsByPath(turns: TurnChanges[], root: string): Map<string, PathChanges> {
	const byPath = new Map<string, PathChanges>();
	if (!root) return byPath;

	for (const turn of turns) {
		for (const file of turn.files) {
			const absolutePath = toAbsolutePath(root, file.path);
			const existing = byPath.get(absolutePath);
			if (existing) {
				existing.turns.push(turn);
				existing.isPending ||= turn.checkpointMessageId === null;
				continue;
			}
			byPath.set(absolutePath, {
				absolutePath,
				relativePath: file.path,
				turns: [turn],
				latestStatus: file.status,
				isPending: turn.checkpointMessageId === null
			});
		}
	}

	return byPath;
}

/**
 * Which marker a file wears.
 *
 * The marker stays for as long as the chat that made the change is open — that
 * is what makes it a record of what the conversation did — but it dims once the
 * change has been staged or committed, so a long session does not end with
 * every file wearing an identical dot that says nothing about what still needs
 * looking at. Outside a git repo there is no staging to read, so nothing dims.
 */
export function markerStateFor(
	changes: PathChanges | null,
	isRepo: boolean,
	unstaged: Set<string>
): AiMarkerState {
	if (!changes) return null;
	if (!isRepo) return 'live';
	return unstaged.has(changes.absolutePath) ? 'live' : 'settled';
}

/** "Changed in turn 3 of this chat" — the first half of the dot's tooltip. */
export function describeTurns(changes: PathChanges): string {
	if (changes.turns.length > 1) return `Changed in ${changes.turns.length} turns of this chat`;

	const turn = changes.turns[0];
	if (turn.checkpointMessageId === null) return 'Changing in the turn running now';
	return `Changed in turn ${turn.turnIndex} of this chat`;
}
