/**
 * Update Status Store
 * Tracks npm package update availability and auto-update state
 */

import ws from '$frontend/utils/ws';
import { systemSettings } from '$frontend/stores/features/settings.svelte';
import { debug } from '$shared/utils/logger';

interface ReleaseNotes {
	tag_name: string;
	body: string;
	html_url: string;
	published_at: string;
}

interface UpdateState {
	currentVersion: string;
	latestVersion: string;
	updateAvailable: boolean;
	checking: boolean;
	updating: boolean;
	dismissed: boolean;
	error: string | null;
	errorType: 'check' | 'update' | null;
	updateOutput: string | null;
	updateSuccess: boolean;
	pendingRestart: boolean;
	pendingVersions: { from: string; to: string } | null;
	showRestartModal: boolean;
	releaseNotes: ReleaseNotes | null;
	releaseNotesLoading: boolean;
	releaseNotesError: string | null;
}

export const updateState = $state<UpdateState>({
	currentVersion: '',
	latestVersion: '',
	updateAvailable: false,
	checking: false,
	updating: false,
	dismissed: false,
	error: null,
	errorType: null,
	updateOutput: null,
	updateSuccess: false,
	pendingRestart: false,
	pendingVersions: null,
	showRestartModal: false,
	releaseNotes: null,
	releaseNotesLoading: false,
	releaseNotesError: null
});

let checkInterval: ReturnType<typeof setInterval> | null = null;

/** Check for updates from npm registry */
export async function checkForUpdate(): Promise<void> {
	if (updateState.checking || updateState.updating) return;

	updateState.checking = true;
	updateState.error = null;
	updateState.errorType = null;

	try {
		const result = await ws.http('system:check-update', {});
		updateState.currentVersion = result.currentVersion;
		updateState.latestVersion = result.latestVersion;
		updateState.updateAvailable = result.updateAvailable;

		// Restore pending restart state from backend (survives page refresh)
		if (result.pendingRestart && result.pendingUpdate) {
			updateState.pendingRestart = true;
			updateState.pendingVersions = { from: result.pendingUpdate.fromVersion, to: result.pendingUpdate.toVersion };
			updateState.updateSuccess = true;
			updateState.latestVersion = result.pendingUpdate.toVersion;
			updateState.showRestartModal = true;
		}

		// Auto-update if enabled and update is available (skip if already pending restart)
		if (result.updateAvailable && systemSettings.autoUpdate && !result.pendingRestart) {
			debug.log('server', 'Auto-update enabled, starting update...');
			await runUpdate();
		}
	} catch (err) {
		updateState.error = err instanceof Error ? err.message : 'Failed to check for updates';
		updateState.errorType = 'check';
		debug.error('server', 'Update check failed:', err);
	} finally {
		updateState.checking = false;
	}
}

/** Run the package update */
export async function runUpdate(): Promise<void> {
	if (updateState.updating) return;

	updateState.updating = true;
	updateState.error = null;
	updateState.errorType = null;
	updateState.updateOutput = null;

	try {
		const result = await ws.http('system:run-update', {});
		updateState.updateOutput = result.output;
		updateState.updateSuccess = true;
		updateState.updateAvailable = false;
		updateState.pendingRestart = true;
		updateState.pendingVersions = { from: updateState.currentVersion, to: result.newVersion };
		updateState.latestVersion = result.newVersion;
		updateState.showRestartModal = true;

		debug.log('server', 'Update completed successfully');
	} catch (err) {
		updateState.error = err instanceof Error ? err.message : 'Update failed';
		updateState.errorType = 'update';
		debug.error('server', 'Update failed:', err);
	} finally {
		updateState.updating = false;
	}
}

/** Fetch latest release notes from GitHub */
export async function fetchReleaseNotes(): Promise<void> {
	if (updateState.releaseNotesLoading) return;
	updateState.releaseNotesLoading = true;
	updateState.releaseNotesError = null;
	try {
		const data = await ws.http('system:get-release-notes', {});
		updateState.releaseNotes = data as ReleaseNotes;
	} catch (err) {
		updateState.releaseNotesError = err instanceof Error ? err.message : 'Failed to load release notes';
		debug.error('server', 'Failed to fetch release notes:', err);
	} finally {
		updateState.releaseNotesLoading = false;
	}
}

/** Dismiss the update banner (not allowed when restart is pending) */
export function dismissUpdate(): void {
	if (updateState.pendingRestart) return;
	updateState.dismissed = true;
}

/** Show the restart instructions modal */
export function showRestartModal(): void {
	updateState.showRestartModal = true;
}

/** Hide the restart instructions modal */
export function hideRestartModal(): void {
	updateState.showRestartModal = false;
}

// Listen for update-completed broadcast (notifies other tabs/clients)
ws.on('system:update-completed', (payload) => {
	debug.log('server', 'Update completed broadcast received');
	updateState.updateSuccess = true;
	updateState.updateAvailable = false;
	updateState.pendingRestart = true;
	updateState.pendingVersions = { from: payload.fromVersion, to: payload.toVersion };
	updateState.latestVersion = payload.toVersion;
	updateState.showRestartModal = true;
	updateState.dismissed = false;
});

/** Start periodic update checks (every 30 minutes) */
export function startUpdateChecker(): void {
	// Initial check after 5 seconds (let the app settle)
	setTimeout(() => {
		checkForUpdate();
	}, 5000);

	// Periodic check every 30 minutes
	if (checkInterval) clearInterval(checkInterval);
	checkInterval = setInterval(() => {
		updateState.dismissed = false; // Reset dismissal on new checks
		checkForUpdate();
	}, 30 * 60 * 1000);
}

/** Stop periodic update checks */
export function stopUpdateChecker(): void {
	if (checkInterval) {
		clearInterval(checkInterval);
		checkInterval = null;
	}
}
