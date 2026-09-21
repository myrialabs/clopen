/**
 * Pure explorer clipboard helpers — the multi-item semantics of copy/paste.
 *
 * The panel (`FilesPanel.svelte`) owns the live clipboard state; these
 * helpers encode the RULES so every trigger (context menu, Ctrl+C/V, OS
 * paste, drag & drop planning) shares one implementation, and so the rules
 * are unit-testable without mounting the panel:
 *
 * - a copy stores EVERY selected item as an array, in selection order —
 *   files, folders and images alike, never just the first one;
 * - a new copy fully replaces the previous entry (no merging);
 * - a menu paste onto a file target lands in that file's parent directory,
 *   exactly like a paste onto a folder lands inside the folder — no matter
 *   which clipboard branch (internal vs fresh OS read) wins the race;
 * - a menu paste fans out to every explicitly selected folder.
 */

import type { FileNode } from '$shared/types/filesystem';

export type ExplorerClipboardOperation = 'copy' | 'cut';
export type ExplorerClipboardOrigin = 'internal' | 'os';

export interface ExplorerClipboardEntry {
	files: FileNode[];
	operation: ExplorerClipboardOperation;
	origin: ExplorerClipboardOrigin;
}

/**
 * Build a clipboard entry from copy/cut targets. The array is snapshotted
 * (`[...targets]`) at copy time, so later selection changes — or a drag loop
 * reusing its buffer — can never shrink or reorder an in-flight copy.
 */
export function buildClipboardEntry(
	targets: FileNode[],
	operation: ExplorerClipboardOperation,
	origin: ExplorerClipboardOrigin = 'internal'
): ExplorerClipboardEntry {
	return { files: [...targets], operation, origin };
}

/**
 * Destination base for a context-menu paste. Directories paste into
 * themselves; a file target resolves to its parent directory. The separator
 * follows the target path so Windows (`\\`) and POSIX (`/`) trees agree.
 */
export function menuPasteBase(targetPath: string, isDirectory: boolean): string {
	if (isDirectory) return targetPath;
	const sep = targetPath.includes('\\') ? '\\' : '/';
	const parts = targetPath.split(/[\\/]/);
	parts.pop();
	return parts.join(sep);
}

/**
 * Menu-paste destinations: every explicitly selected folder when 2+ folders
 * are selected (fan-out, one copy per folder), otherwise the single fallback
 * base derived from the clicked target.
 */
export function resolveMenuDests(selectedDirs: string[], fallbackBase: string): string[] {
	return selectedDirs.length >= 2 ? [...selectedDirs] : [fallbackBase];
}
