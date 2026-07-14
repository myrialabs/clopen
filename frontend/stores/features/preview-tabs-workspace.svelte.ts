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
import { registerDock, getActiveWorkspaceProjectId } from '$frontend/stores/ui/project-workspace.svelte';
import { showInfo, showWarning } from '$frontend/stores/ui/notification.svelte';
import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';

/** Module-level tab manager — shared across BrowserPreview mounts. */
export const previewTabManager: TabManager = createTabManager();

/**
 * Backend tab IDs currently under MCP control for the ACTIVE project. Single
 * source of truth for "is this tab MCP-controlled", shared by the always-on
 * sync below and every BrowserPreview mount (the per-mount mcpHandler reads
 * this set). Seeded from the backend in load() (recovered tabs) and kept live
 * by the control-start/end listeners, so the badge/lock survives a
 * BrowserPreview unmount/remount and updates even while the panel is hidden.
 */
let mcpControlledBackendIds = $state(new Set<string>());

export function getMcpControlledBackendIds(): ReadonlySet<string> {
	return mcpControlledBackendIds;
}

/** Add/remove a backend tab id from the controlled set (reassign for reactivity). */
function setMcpControlled(backendTabId: string, controlled: boolean): void {
	if (controlled === mcpControlledBackendIds.has(backendTabId)) return;
	const next = new Set(mcpControlledBackendIds);
	if (controlled) next.add(backendTabId);
	else next.delete(backendTabId);
	mcpControlledBackendIds = next;
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
		setMcpControlled(backendTab.tabId, true);
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
		mcpControlledBackendIds = new Set();
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

// ============================================================================
// Always-on tab-lifecycle sync
//
// Tab lifecycle (open/close/switch/viewport) and MCP control events must be
// applied to the singleton tab-list regardless of whether the Preview panel is
// mounted. Previously these listeners lived inside BrowserPreview's per-mount
// coordinator, so a tab MCP opened while the panel was hidden/minimized never
// materialized until the next project switch (or a full page reload forced the
// dock's load()). Registering them once here — on the module-level singleton —
// keeps the tab-list authoritative in real time.
// ============================================================================

/**
 * Whether a project-stamped backend event targets the project currently shown
 * by the singleton tab-list. The singleton only ever holds the active project's
 * tabs, so an event for a project the user switched away from must be dropped —
 * that tab stays in its own project and is recovered via load() on switch-back.
 * Unstamped events (older backend / no projectId) are accepted so we never drop
 * legitimate events we can't attribute.
 */
function isEventForActiveProject(data: { projectId?: string } | null | undefined): boolean {
	const eventProjectId = data?.projectId;
	if (!eventProjectId) return true;
	const activeProjectId = getActiveWorkspaceProjectId();
	if (!activeProjectId) return true;
	return eventProjectId === activeProjectId;
}

let tabSyncInitialized = false;

/**
 * Register the always-on tab-lifecycle listeners. Idempotent — safe to call
 * more than once (e.g. HMR); only the first call wires listeners.
 */
export function initPreviewTabSync(): void {
	if (tabSyncInitialized) return;
	tabSyncInitialized = true;

	debug.log('preview', '🎧 [dock] Registering always-on tab-lifecycle listeners');

	ws.on('preview:browser-tab-opened', (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-tab-opened:', data);

		// Drop events for a project the user has switched away from.
		if (!isEventForActiveProject(data)) {
			debug.log('preview', `⏭️ [dock] Ignoring tab-opened for inactive project ${data?.projectId}`);
			return;
		}

		// Already linked to a frontend tab (by backend sessionId) — nothing to do.
		const existingTab = previewTabManager.tabs.find((t) => t.sessionId === data.tabId);
		if (existingTab) {
			debug.log('preview', `✓ [dock] Backend tab ${data.tabId} already linked, skipping`);
			return;
		}

		// A tab the frontend is launching (user typed a URL) is awaiting its
		// backend session — link this event to it instead of creating a duplicate.
		const launchingTab = previewTabManager.tabs.find((t) => t.isLaunchingBrowser && !t.sessionId);
		if (launchingTab) {
			debug.log('preview', `🔗 [dock] Linking launching tab ${launchingTab.id} → backend ${data.tabId}`);
			previewTabManager.updateTab(launchingTab.id, {
				sessionId: data.tabId,
				sessionInfo: {
					quality: 'good',
					url: data.url,
					deviceSize: data.deviceSize,
					rotation: data.rotation
				},
				url: data.url,
				title: data.title,
				deviceSize: data.deviceSize || 'laptop',
				rotation: data.rotation || 'landscape',
				isConnected: true,
				isStreamReady: false,
				isLoading: false,
				errorMessage: null
			});
			// Session registration is handled by launchBrowserForTab.
			return;
		}

		// Backend-initiated tab (e.g. MCP) — create a matching frontend tab.
		const frontendTabId = previewTabManager.createTab(data.url);
		previewTabManager.updateTab(frontendTabId, {
			sessionId: data.tabId,
			sessionInfo: {
				quality: 'good',
				url: data.url,
				deviceSize: data.deviceSize,
				rotation: data.rotation
			},
			url: data.url,
			title: data.title,
			deviceSize: data.deviceSize || 'laptop',
			rotation: data.rotation || 'landscape',
			isConnected: true,
			isStreamReady: false,
			isLoading: false,
			errorMessage: null
		});

		browserCleanup.registerSession(data.tabId);

		if (data.isActive) {
			previewTabManager.switchTab(frontendTabId);
		}

		debug.log('preview', `✅ [dock] Frontend tab created: ${frontendTabId} → backend ${data.tabId}`);
	});

	ws.on('preview:browser-tab-closed', (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-tab-closed:', data);

		if (!isEventForActiveProject(data)) return;

		const tab = previewTabManager.tabs.find((t) => t.sessionId === data.tabId);
		if (!tab) return;

		previewTabManager.closeTab(tab.id);
		browserCleanup.unregisterSession(data.tabId);
		setMcpControlled(data.tabId, false);

		// Backend-driven close (e.g. MCP) left zero tabs → reseed an empty one so
		// the panel doesn't render as a void.
		if (previewTabManager.getAllTabs().length === 0) {
			debug.log('preview', '📝 [dock] No tabs after backend close, seeding empty tab');
			previewTabManager.createTab('');
		}
	});

	ws.on('preview:browser-tab-switched', (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-tab-switched:', data);

		if (!isEventForActiveProject(data)) return;

		const tab = previewTabManager.tabs.find((t) => t.sessionId === data.newTabId);
		if (tab) previewTabManager.switchTab(tab.id);
	});

	ws.on('preview:browser-viewport-changed' as any, (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-viewport-changed:', data);

		if (!isEventForActiveProject(data)) return;

		const tab = previewTabManager.tabs.find((t) => t.sessionId === data.tabId);
		if (tab) {
			previewTabManager.updateTab(tab.id, {
				deviceSize: data.deviceSize,
				rotation: data.rotation
			});
		}
	});

	ws.on('preview:browser-mcp-control-start', (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-mcp-control-start:', data);

		if (!isEventForActiveProject(data)) return;

		const wasEmpty = mcpControlledBackendIds.size === 0;
		setMcpControlled(data.browserTabId, true);

		// Toast only for the first controlled tab of the active project.
		if (wasEmpty && mcpControlledBackendIds.size === 1) {
			showWarning(
				'MCP Control Started',
				'An MCP agent is now controlling the browser. User input is blocked.',
				5000
			);
		}
	});

	ws.on('preview:browser-mcp-control-end', (data: any) => {
		debug.log('preview', '📥 [dock] preview:browser-mcp-control-end:', data);

		if (!isEventForActiveProject(data)) return;

		setMcpControlled(data.browserTabId, false);

		// Toast when all tabs released.
		if (mcpControlledBackendIds.size === 0) {
			showInfo(
				'MCP Control Ended',
				'MCP agent released control. You can now interact with the browser.',
				4000
			);
		}
	});
}
