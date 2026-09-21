/**
 * Per-turn file changes, read from checkpoint snapshots.
 *
 * This is the source of truth for "what did this turn change", and it is
 * deliberately NOT derived from tool calls. A snapshot is a gitignore-aware
 * disk diff, so it sees a file rewritten by `sed`, a formatter, a codemod, an
 * `apply_patch`, a notebook edit or a sub-agent — none of which necessarily
 * surface as an Edit/Write tool_use, and several of which reach the frontend
 * with their inputs stripped (see subagent-wire-trim.ts). Reading the disk
 * instead of the transcript means a tool that does not exist yet is already
 * handled.
 *
 * The trade-off is honest and must stay visible in the UI: a turn's delta is
 * everything that changed on disk while the turn ran, which can include the
 * user's own save or a build artifact that no .gitignore covers. It is "changed
 * during this turn", not "provably written by the model".
 */

import type { SessionScopedChanges } from '$shared/types/database/schema';
import { countLineChanges, isBinaryBuffer } from '$shared/utils/diff-calculator';

export { isBinaryBuffer };

export type TurnFileStatus = 'added' | 'modified' | 'deleted';

export interface TurnFileChange {
	/** Project-relative path with forward slashes, as stored in the snapshot. */
	path: string;
	status: TurnFileStatus;
	insertions: number;
	deletions: number;
	isBinary: boolean;
	/**
	 * False when a blob this file needs is no longer readable. The change still
	 * happened — only its content is gone — so the row is kept and the UI says
	 * so, rather than rendering a diff of nothing.
	 */
	contentAvailable: boolean;
}

/** Which way a file moved, decided by which side of the change has content. */
export function statusOf(oldHash: string, newHash: string): TurnFileStatus {
	if (!oldHash) return 'added';
	if (!newHash) return 'deleted';
	return 'modified';
}

/**
 * Turn one checkpoint's `session_changes` into a displayable file list.
 *
 * `readBlob` is injected so this stays a pure function over its inputs — the
 * only I/O is the reader the caller hands in.
 */
export async function buildTurnFiles(
	changes: SessionScopedChanges,
	readBlob: (hash: string) => Promise<Buffer>
): Promise<TurnFileChange[]> {
	const files: TurnFileChange[] = [];

	for (const [path, change] of Object.entries(changes)) {
		const status = statusOf(change.oldHash, change.newHash);

		let oldBuf: Buffer | null = null;
		let newBuf: Buffer | null = null;
		let contentAvailable = true;

		if (change.oldHash) {
			try {
				oldBuf = await readBlob(change.oldHash);
			} catch {
				contentAvailable = false;
			}
		}
		if (change.newHash) {
			try {
				newBuf = await readBlob(change.newHash);
			} catch {
				contentAvailable = false;
			}
		}

		const isBinary =
			(oldBuf !== null && isBinaryBuffer(oldBuf)) || (newBuf !== null && isBinaryBuffer(newBuf));

		let insertions = 0;
		let deletions = 0;
		if (contentAvailable && !isBinary) {
			const counts = countLineChanges(
				oldBuf ? oldBuf.toString('utf8') : '',
				newBuf ? newBuf.toString('utf8') : ''
			);
			insertions = counts.additions;
			deletions = counts.deletions;
		}

		files.push({ path, status, insertions, deletions, isBinary, contentAvailable });
	}

	// Natural sort: a turn's file list is read as a checklist, and a stable order
	// is what lets the eye return to the same row after a refetch.
	files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
	return files;
}

/**
 * The prompt excerpt a turn row shows.
 *
 * Bounded because a single instruction can run to thousands of characters and
 * every turn of the chat is sent at once, but cut marks itself with an ellipsis:
 * a row that silently ends mid-sentence reads as the whole question.
 */
export function excerptPrompt(text: string, limit: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** Roll a turn's file list up into the numbers a turn header shows. */
export function summariseTurnFiles(files: TurnFileChange[]): {
	filesChanged: number;
	insertions: number;
	deletions: number;
} {
	let insertions = 0;
	let deletions = 0;
	for (const file of files) {
		insertions += file.insertions;
		deletions += file.deletions;
	}
	return { filesChanged: files.length, insertions, deletions };
}
