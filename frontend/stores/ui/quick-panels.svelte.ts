/**
 * Quick Panels Store
 * SSOT for the open/closed state of top-level panels that can be triggered
 * from more than one entry point (sidebar footer buttons, Command Palette).
 * Data/logic for each panel still lives in its own feature store — this only
 * tracks whether the modal is visible.
 */

interface QuickPanelsState {
	newProjectOpen: boolean;
	remoteAccessOpen: boolean;
	tunnelOpen: boolean;
	dbClientOpen: boolean;
}

export const quickPanelsState = $state<QuickPanelsState>({
	newProjectOpen: false,
	remoteAccessOpen: false,
	tunnelOpen: false,
	dbClientOpen: false
});

export function openNewProjectDialog() {
	quickPanelsState.newProjectOpen = true;
}

export function closeNewProjectDialog() {
	quickPanelsState.newProjectOpen = false;
}

export function openRemoteAccessDialog() {
	quickPanelsState.remoteAccessOpen = true;
}

export function closeRemoteAccessDialog() {
	quickPanelsState.remoteAccessOpen = false;
}

export function openTunnelDialog() {
	quickPanelsState.tunnelOpen = true;
}

export function closeTunnelDialog() {
	quickPanelsState.tunnelOpen = false;
}

export function openDbClientDialog() {
	quickPanelsState.dbClientOpen = true;
}

export function closeDbClientDialog() {
	quickPanelsState.dbClientOpen = false;
}
