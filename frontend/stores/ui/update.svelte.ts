/**
 * Update Status Store
 * Tracks npm package update availability and auto-update state
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';
import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
import { debug } from '$shared/utils/logger';
import { compareVersions } from '$shared/utils/semver';
import type { ReleaseNote } from '$shared/types/release-notes';

interface UpdateState {
	currentVersion: string;
	latestVersion: string;
	updateAvailable: boolean;
	checking: boolean;
	/** When the last check finished successfully (ms epoch). */
	lastCheckedAt: number | null;
	updating: boolean;
	dismissed: boolean;
	error: string | null;
	errorType: 'check' | 'update' | null;
	updateOutput: string | null;
	updateSuccess: boolean;
	pendingRestart: boolean;
	pendingVersions: { from: string; to: string } | null;
	releaseNotes: ReleaseNote[] | null;
	releaseNotesLoading: boolean;
	releaseNotesError: string | null;
	/**
	 * The What's new dialog. One dialog for both moments: before an update it
	 * previews what is coming, after one it says what landed and how to finish.
	 */
	showWhatsNewModal: boolean;
}

export const updateState = $state<UpdateState>({
	currentVersion: '',
	latestVersion: '',
	updateAvailable: false,
	checking: false,
	lastCheckedAt: null,
	updating: false,
	dismissed: false,
	error: null,
	errorType: null,
	updateOutput: null,
	updateSuccess: false,
	pendingRestart: false,
	pendingVersions: null,
	releaseNotes: null,
	releaseNotesLoading: false,
	releaseNotesError: null,
	showWhatsNewModal: false
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
		updateState.lastCheckedAt = Date.now();

		// Restore pending restart state from backend (survives page refresh)
		if (result.pendingRestart && result.pendingUpdate) {
			updateState.pendingRestart = true;
			updateState.pendingVersions = { from: result.pendingUpdate.fromVersion, to: result.pendingUpdate.toVersion };
			updateState.updateSuccess = true;
			updateState.latestVersion = result.pendingUpdate.toVersion;
			updateState.showWhatsNewModal = true;
			fetchReleaseNotes();
		}

		// Auto-update if enabled and update is available (skip if already pending restart)
		if (result.updateAvailable && systemSettings.autoUpdate && !result.pendingRestart) {
			debug.log('server', 'Auto-update enabled, starting update...');
			await runUpdate();
		} else if (
			result.updateAvailable &&
			!result.pendingRestart &&
			systemSettings.lastSeenReleaseNotesVersion !== result.latestVersion
		) {
			// Manual-update users get a "what's new" preview before they decide to update.
			// Auto-update users skip this (the update is about to happen anyway) and instead
			// see the changelog folded into the post-update restart dialog.
			await fetchReleaseNotes();
			updateState.showWhatsNewModal = true;
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
		updateState.showWhatsNewModal = true;
		fetchReleaseNotes();

		debug.log('server', 'Update completed successfully');
	} catch (err) {
		updateState.error = err instanceof Error ? err.message : 'Update failed';
		updateState.errorType = 'update';
		debug.error('server', 'Update failed:', err);
	} finally {
		updateState.updating = false;
	}
}

/**
 * Whether the loaded releases already reach `version`. A list fetched before
 * a newer release came out does not, so asking again is how the dialog for
 * that newer release gets its notes instead of showing the old list.
 */
function hasNotesFor(version: string): boolean {
	const releases = updateState.releaseNotes;
	if (!releases) return false;
	return !version || releases.some(release => compareVersions(release.version, version) >= 0);
}

/** Fetch Clopen's recent releases from GitHub, parsed into grouped changes */
export async function fetchReleaseNotes(): Promise<void> {
	if (updateState.releaseNotesLoading || hasNotesFor(updateState.latestVersion)) return;
	updateState.releaseNotesLoading = true;
	updateState.releaseNotesError = null;
	try {
		const data = await ws.http('system:get-release-notes', {});
		updateState.releaseNotes = data;
	} catch (err) {
		updateState.releaseNotesError = err instanceof Error ? err.message : 'Failed to load release notes';
		debug.error('server', 'Failed to fetch release notes:', err);
	} finally {
		updateState.releaseNotesLoading = false;
	}
}

/** Fetch release notes again regardless of what is loaded (the retry button) */
export async function refetchReleaseNotes(): Promise<void> {
	updateState.releaseNotes = null;
	await fetchReleaseNotes();
}

/** Open the What's new dialog on demand (banner, Settings → Updates). */
export function openWhatsNew(): void {
	updateState.showWhatsNewModal = true;
	fetchReleaseNotes();
}

/**
 * Close the What's new dialog. For an available update, remember the version so
 * the preview does not pop up again for it; after an update, the dialog stays
 * reachable from the banner until the restart.
 */
export function dismissWhatsNew(): void {
	updateState.showWhatsNewModal = false;
	if (updateState.updateAvailable && !updateState.pendingRestart) {
		updateSystemSettings({ lastSeenReleaseNotesVersion: updateState.latestVersion });
	}
}

/** Releases after `from`, up to and including `to`, newest first. */
export function releasesBetween(releases: ReleaseNote[], from: string, to: string): ReleaseNote[] {
	return releases.filter(release => compareVersions(release.version, from) > 0 && compareVersions(release.version, to) <= 0);
}

/** Dismiss the update banner (not allowed when restart is pending) */
export function dismissUpdate(): void {
	if (updateState.pendingRestart) return;
	updateState.dismissed = true;
}

// Listen for update-completed broadcast (notifies other tabs/clients)
ws.on('system:update-completed', (payload) => {
	debug.log('server', 'Update completed broadcast received');
	updateState.updateSuccess = true;
	updateState.updateAvailable = false;
	updateState.pendingRestart = true;
	updateState.pendingVersions = { from: payload.fromVersion, to: payload.toVersion };
	updateState.latestVersion = payload.toVersion;
	updateState.showWhatsNewModal = true;
	updateState.dismissed = false;
	fetchReleaseNotes();
});

// After a WS reconnect (e.g. the server process was restarted to apply an update),
// verify the server is still running the version this tab last observed. A mismatch
// means the reconnect happened against new code — the loaded JS/CSS bundle is stale,
// so reload instead of leaving the user on an old frontend talking to a new backend.
// Version numbers only change on a real update (not on `bun --watch` dev restarts),
// so this won't fire on every backend hot-reload during development.
onWsReconnect(() => {
	if (!updateState.currentVersion) return;
	ws.http('system:check-update', {})
		.then(result => {
			if (result.currentVersion !== updateState.currentVersion) {
				debug.log('server', `Server version changed after reconnect (${updateState.currentVersion} -> ${result.currentVersion}), reloading`);
				window.location.reload();
			}
		})
		.catch(err => {
			debug.error('server', 'Version check after reconnect failed:', err);
		});
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
