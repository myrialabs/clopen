/**
 * On-disk storage for note image attachments.
 *
 * Files live at `<DATA_DIR>/notes/<collectionId>/<noteId>/<uuid>-<name>`, but
 * `note_images.storage_path` holds that location *relative* to the data dir,
 * with forward slashes. An absolute path would pin every attachment to the
 * machine that uploaded it: `CLOPEN_DATA_DIR` is a supported override, and a
 * `~/.clopen` copied from macOS to Windows would carry `/Users/...` paths that
 * resolve nowhere on the target. Relative + POSIX separators survives both.
 */

import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

import { getClopenDir } from '../utils/paths';
import { noteCollectionQueries } from '../database/queries/note-queries';
// One exported implementation already lives with the worktree paths; notes
// resolve the same class of "is this inside the directory I own" question.
import { isPathInside } from '../worktrees/paths';

/**
 * Longest attachment file name kept after sanitizing.
 *
 * Windows still caps a full path at 260 characters by default. The rest of an
 * attachment path costs roughly 150 (data dir + `notes` + two UUID directories
 * + the UUID prefix), so anything past 64 risks an upload that succeeds on
 * macOS and Linux and fails on Windows with ENAMETOOLONG.
 */
const MAX_FILE_NAME_LENGTH = 64;

/** Root that holds every note attachment of every project. */
export function getNotesRootDir(): string {
	return join(getClopenDir(), 'notes');
}

/** Directory that holds one collection's note attachments. */
export function getCollectionNotesDir(collectionId: string): string {
	return join(getNotesRootDir(), collectionId);
}

/** Directory that holds one note's attachments. */
export function getNoteDir(collectionId: string, noteId: string): string {
	return join(getCollectionNotesDir(collectionId), noteId);
}

/**
 * Reduce a client-supplied name to something safe on every filesystem.
 *
 * Windows rejects `<>:"/\|?*` and silently drops trailing dots and spaces — a
 * dropped trailing dot would leave the database pointing at a file name the OS
 * never wrote. Reserved device names (CON, NUL, …) can't occur because the
 * stored name is always prefixed with the image UUID.
 */
export function sanitizeImageFileName(name: string): string {
	const flattened = name.split(/[\\/]/).pop() ?? '';
	// Trailing dots and spaces go before the character replacement, not after:
	// afterwards a trailing space is already an underscore and would survive.
	const trimmed = flattened.replace(/[.\s]+$/, '').trim();
	const cleaned = trimmed
		.replace(/[^a-zA-Z0-9._-]/g, '_')
		.slice(0, MAX_FILE_NAME_LENGTH)
		// The length cap can land on a dot, which puts one back at the end.
		.replace(/\.+$/, '');
	return cleaned || 'image';
}

/** The value to persist in `note_images.storage_path`. */
export function noteImageRelPath(collectionId: string, noteId: string, fileName: string): string {
	return `notes/${collectionId}/${noteId}/${fileName}`;
}

/**
 * Turn a stored path back into an absolute one under the current data dir.
 *
 * Returns null when the value escapes the notes root — a stored path is always
 * server-generated, so an escape means the row was tampered with and the read
 * must not fall through to an arbitrary file.
 */
export function resolveNoteImagePath(storagePath: string): string | null {
	if (!storagePath) return null;
	const absolute = storagePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(storagePath)
		? resolve(storagePath)
		: resolve(join(getClopenDir(), ...storagePath.split('/')));
	return isPathInside(getNotesRootDir(), absolute) ? absolute : null;
}

/** Remove one note's attachment directory. Best-effort: never throws. */
export async function removeNoteFiles(collectionId: string, noteId: string): Promise<void> {
	await rm(getNoteDir(collectionId, noteId), { recursive: true, force: true }).catch(() => {});
}

/** Remove one collection's attachment directory. Best-effort: never throws. */
export async function removeCollectionFiles(collectionId: string): Promise<void> {
	const root = getNotesRootDir();
	const dir = getCollectionNotesDir(collectionId);
	// The directory is derived from the id, so an empty or traversing id would
	// aim this recursive delete at the notes root itself.
	if (dir === root || !isPathInside(root, dir)) return;
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Remove every attachment belonging to a project's note collections.
 *
 * Deleting the project cascades the collections, notes and image rows away, so
 * without this the files would have no row left to point at them and would sit
 * in the data dir until the user found them by hand. Runs before the project
 * row is deleted, while the collection ids can still be resolved.
 */
export async function removeProjectNotes(projectId: string): Promise<void> {
	for (const collectionId of noteCollectionQueries.idsByProject(projectId)) {
		await removeCollectionFiles(collectionId);
	}
}
