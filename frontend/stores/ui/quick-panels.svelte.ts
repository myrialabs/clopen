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
	sshClientOpen: boolean;
	portsOpen: boolean;
	containersOpen: boolean;
	memoryOpen: boolean;
	notesOpen: boolean;
	workOpen: boolean;
	/** Opened with the pull-request composer already up. */
	workComposePr: boolean;
}

export const quickPanelsState = $state<QuickPanelsState>({
	newProjectOpen: false,
	remoteAccessOpen: false,
	tunnelOpen: false,
	dbClientOpen: false,
	sshClientOpen: false,
	portsOpen: false,
	containersOpen: false,
	memoryOpen: false,
	notesOpen: false,
	workOpen: false,
	workComposePr: false
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

export function openSshClientDialog() {
	quickPanelsState.sshClientOpen = true;
}

export function closeSshClientDialog() {
	quickPanelsState.sshClientOpen = false;
}

export function openPortsDialog() {
	quickPanelsState.portsOpen = true;
}

export function closePortsDialog() {
	quickPanelsState.portsOpen = false;
}

export function openContainersDialog() {
	quickPanelsState.containersOpen = true;
}

export function closeContainersDialog() {
	quickPanelsState.containersOpen = false;
}

export function openMemoryDialog() {
	quickPanelsState.memoryOpen = true;
}

export function closeMemoryDialog() {
	quickPanelsState.memoryOpen = false;
}

export function openNotesDialog() {
	quickPanelsState.notesOpen = true;
}

export function closeNotesDialog() {
	quickPanelsState.notesOpen = false;
}

/**
 * The Issues & PRs surface.
 *
 * `composePullRequest` is how the Git panel's "Open pull request" reaches the
 * same surface rather than growing its own composer — one room, several doors.
 */
export function openWorkDialog(options: { composePullRequest?: boolean } = {}) {
	quickPanelsState.workComposePr = options.composePullRequest === true;
	quickPanelsState.workOpen = true;
}

export function closeWorkDialog() {
	quickPanelsState.workOpen = false;
	quickPanelsState.workComposePr = false;
}
