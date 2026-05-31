/**
 * Preview Tabs Dock Workspace State
 *
 * The Preview dock's tab-list (which browser tabs exist + which is active) is
 * managed by a module-level singleton `previewTabManager`. This survives the
 * BrowserPreview component's mount/unmount lifecycle so the panel can render
 * the tabs immediately on (re)open instead of flashing a default empty tab
 * while an async backend round-trip restores them.
 *
 * The dock's `load()` runs inside the workspace coordinator's switch barrier
 * (awaited before reveal), so by the time the Preview panel becomes visible
 * the tab-list is already authoritative — same pattern as the terminal dock.
 *
 * Persistence: backend tabs (those with a live browser session) are recovered
 * from the server in `load()`. Empty / not-yet-launched tabs have no backend
 * session, so they would be lost on a project switch. To keep them, `snapshot()`
 * serializes the full frontend tab-list (including blank slots) into the
 * per-project workspace blob and `load()` reconciles it with the backend tabs.
 */

import {
	createTabManager,
	getTabTitle,
	type TabManager
} from '$frontend/components/preview/browser/core/tab-manager.svelte';
import {
	getExistingTabs,
	switchToBackendTab,
	type ExistingTabInfo
} from '$frontend/components/preview/browser/core/tab-operations.svelte';
import { browserCleanup } from '$frontend/components/preview/browser/core/cleanup.svelte';
import { setInteractionProjectId } from '$frontend/components/preview/browser/core/interactions.svelte';
import { registerDock } from '$frontend/stores/ui/project-workspace.svelte';
import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';

/** Module-level tab manager — shared across BrowserPreview mounts. */
export const previewTabManager: TabManager = createTabManager();

/**
 * MCP-controlled tabs recovered for the active project. The per-mount
 * mcpHandler restores its control state from this list on every coordinator
 * initialize, so the list persists for the lifetime of the project (cleared in
 * the dock's clear()) and survives a BrowserPreview unmount/remount.
 */
let recoveredMcpControlledTabs: Array<{ frontendId: string; backendId: string }> = [];

export function getRecoveredMcpControlledTabs(): ReadonlyArray<{
	frontendId: string;
	backendId: string;
}> {
	return recoveredMcpControlledTabs;
}

/**
 * Serializable description of one tab slot, persisted in the workspace blob.
 * `sessionId` ties the slot back to a backend browser session (null for blank
 * tabs the user opened but never launched).
 */
interface TabSnapshotSlot {
	url: string;
	title: string;
	deviceSize: DeviceSize;
	rotation: Rotation;
	sessionId: string | null;
	isActive: boolean;
}

/** Slice restored from the workspace blob, consumed by the next load(). */
let restoredSnapshot: TabSnapshotSlot[] | null = null;

/** Materialize a recovered backend tab into the singleton; returns its frontend id. */
function materializeBackendTab(backendTab: ExistingTabInfo): string {
	const frontendId = previewTabManager.createTab(backendTab.url);

	previewTabManager.updateTab(frontendId, {
		sessionId: backendTab.tabId,
		sessionInfo: {
			quality: backendTab.quality,
			url: backendTab.url,
			deviceSize: backendTab.deviceSize as DeviceSize,
			rotation: backendTab.rotation as Rotation
		},
		url: backendTab.url,
		title: backendTab.title || getTabTitle(backendTab.url),
		deviceSize: backendTab.deviceSize as DeviceSize,
		rotation: backendTab.rotation as Rotation,
		isConnected: true,
		isStreamReady: false,
		isLoading: false,
		isLaunchingBrowser: false,
		isNavigating: false,
		errorMessage: null
	});

	browserCleanup.registerSession(backendTab.tabId);

	if (backendTab.isMcpControlled) {
		recoveredMcpControlledTabs.push({ frontendId, backendId: backendTab.tabId });
	}

	return frontendId;
}

/** Re-create a blank (session-less) tab slot from a persisted snapshot. */
function materializeBlankTab(slot: TabSnapshotSlot): string {
	const frontendId = previewTabManager.createTab(slot.url || '');
	previewTabManager.updateTab(frontendId, {
		title: slot.title || getTabTitle(slot.url),
		deviceSize: slot.deviceSize,
		rotation: slot.rotation
	});
	return frontendId;
}

/**
 * Rebuild the singleton tab-list for `projectId` by reconciling the persisted
 * snapshot (slot order + blank tabs) with the backend's live sessions.
 */
async function reconcileTabs(projectId: string): Promise<void> {
	let backendTabs: ExistingTabInfo[] = [];
	try {
		const result = await getExistingTabs(projectId);
		if (result && result.count > 0) {
			backendTabs = result.tabs;
			debug.log('preview', `✅ [dock load] Found ${result.count} backend tabs for project ${projectId}`);
		} else {
			debug.log('preview', '📭 [dock load] No existing backend tabs to recover');
		}
	} catch (err) {
		debug.error('preview', '❌ [dock load] Failed to recover preview tabs:', err);
	}

	// Consume the snapshot restored for this project (cleared so a later load
	// without a blob — e.g. a project that has none — starts fresh).
	const snapshot = restoredSnapshot;
	restoredSnapshot = null;

	const usedBackendIds = new Set<string>();
	let activeFrontendId: string | null = null;

	// 1. Replay snapshot slots in their original order so blank tabs survive and
	//    tab positions are preserved across the switch.
	if (snapshot && snapshot.length > 0) {
		for (const slot of snapshot) {
			if (slot.sessionId) {
				const backendTab = backendTabs.find((b) => b.tabId === slot.sessionId);
				if (!backendTab) continue; // Session is gone (browser closed) — drop the slot.
				usedBackendIds.add(backendTab.tabId);
				const frontendId = materializeBackendTab(backendTab);
				if (slot.isActive || backendTab.isActive) activeFrontendId = frontendId;
			} else {
				const frontendId = materializeBlankTab(slot);
				if (slot.isActive) activeFrontendId = frontendId;
			}
		}
	}

	// 2. Append any backend tabs not referenced by the snapshot — e.g. tabs MCP
	//    opened while the user was viewing another project, or the no-snapshot
	//    path (first visit) where the backend is the sole source of truth.
	for (const backendTab of backendTabs) {
		if (usedBackendIds.has(backendTab.tabId)) continue;
		const frontendId = materializeBackendTab(backendTab);
		if (backendTab.isActive && !activeFrontendId) activeFrontendId = frontendId;
	}

	// 3. Activate the resolved tab (default to the first one) and sync the
	//    backend's active tab so streaming comes from the right session.
	if (!activeFrontendId) {
		const first = previewTabManager.getAllTabs()[0];
		activeFrontendId = first ? first.id : null;
	}
	if (activeFrontendId) {
		previewTabManager.switchTab(activeFrontendId);
		const activeTab = previewTabManager.getTab(activeFrontendId);
		if (activeTab?.sessionId) {
			await switchToBackendTab(activeTab.sessionId, projectId);
		}
	}
}

registerDock({
	id: 'preview-tabs',
	clear() {
		// Wipe the outgoing project's tabs so nothing flashes through the switch.
		previewTabManager.clearAllTabs();
		browserCleanup.clearAll();
		recoveredMcpControlledTabs = [];
		restoredSnapshot = null;
	},
	snapshot(): TabSnapshotSlot[] {
		// Capture the full tab-list (blank tabs included) so it can be rebuilt on
		// the next switch back to this project. Heavy/transient fields (canvas,
		// frame data) are intentionally excluded.
		const activeTabId = previewTabManager.activeTabId;
		return previewTabManager.getAllTabs().map((tab) => ({
			url: tab.url,
			title: tab.title,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			sessionId: tab.sessionId,
			isActive: tab.id === activeTabId
		}));
	},
	restore(slice) {
		restoredSnapshot = Array.isArray(slice) ? (slice as TabSnapshotSlot[]) : null;
	},
	async load(projectId) {
		if (!projectId) return;
		// Update the interactions module's projectId so any subsequent sends use it.
		setInteractionProjectId(projectId);

		await reconcileTabs(projectId);

		// Authoritative seeding: when neither snapshot nor backend produced any
		// tabs, drop a single empty tab inside the switch barrier. This is the ONLY
		// place the panel seeds itself on a project switch — the component never
		// adds "New Tab" speculatively, so the count matches MCP/backend exactly.
		if (previewTabManager.getAllTabs().length === 0) {
			debug.log('preview', '📝 [dock load] Seeding empty tab for empty project');
			previewTabManager.createTab('');
		}
	}
});
