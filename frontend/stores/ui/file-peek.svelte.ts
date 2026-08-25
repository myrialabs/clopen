/**
 * File Peek Store
 *
 * Drives a lightweight, transient single-file viewer shown as a modal when a
 * file link is activated (from chat, git changes, etc.) while the Files panel
 * is NOT part of the current layout. When the Files panel IS visible, the file
 * is revealed in place instead — see `revealFile`.
 */

import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';
import { requestRevealFile } from '$frontend/stores/core/files.svelte';

interface FilePeekState {
	// Absolute path of the file currently peeked, or null when the modal is closed.
	path: string | null;
}

export const filePeekState = $state<FilePeekState>({
	path: null
});

export function openFilePeek(path: string): void {
	filePeekState.path = path;
}

export function closeFilePeek(): void {
	filePeekState.path = null;
}

/**
 * Reveal a file for the user. If the Files panel is part of the current layout,
 * reveal it there in place; otherwise open it in a transient peek modal so the
 * click still does something without disturbing the arranged layout.
 */
export function revealFile(path: string): void {
	if (!path) return;
	if (getVisiblePanels(workspaceState.layout).includes('files')) {
		requestRevealFile(path);
	} else {
		openFilePeek(path);
	}
}
