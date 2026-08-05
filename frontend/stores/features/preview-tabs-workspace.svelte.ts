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
import ws, { onWsReconnect } from '$frontend/utils/ws';
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

/**
 * Backend tab ids an agent is acting on right now.
 *
 * A lock only says "hands off". Once an agent is working across several tabs
 * that leaves every one of them looking identical, and the user cannot tell
 * where to look — they can still browse freely, they just had no way of
 * knowing which tab was live. Seeded from the backend in load() and kept
 * current by the focus listener below.
 *
 * A set rather than a single id: one project can have two runs going, and each
 * has a tab of its own to point at. A tab is held by at most one session, so
 * membership here is never ambiguous.
 */
let mcpFocusedBackendIds = $state(new Set<string>());

/**
 * Where each agent's pointer stands, in *page* coordinates, per backend tab.
 *
 * Kept for every controlled tab, not only the one on screen. The pointer is
 * silent between actions, so a viewer that starts watching a tab mid-run has
 * nothing to draw from unless the position was being recorded all along —
 * which is exactly what made switching to the tab an agent was working on show
 * a pointer frozen in the middle of the page.
 *
 * Position only. Whether the pointer is *drawn* follows from the lock and the
 * focus mark above, never from this — otherwise the tail of an interrupted
 * batch would put it back on screen after the agent had been told to stop.
 */
let mcpCursorByBackendId = $state<Record<string, { x: number; y: number; pressed: boolean; clicking: boolean }>>({});

export function getMcpControlledBackendIds(): ReadonlySet<string> {
	return mcpControlledBackendIds;
}

export function isBackendTabMcpFocused(backendTabId: string | null): boolean {
	return !!backendTabId && mcpFocusedBackendIds.has(backendTabId);
}

export function getMcpCursor(
	backendTabId: string | null
): { x: number; y: number; pressed: boolean; clicking: boolean } | null {
	return backendTabId ? (mcpCursorByBackendId[backendTabId] ?? null) : null;
}

/**
 * How long a click's ripple stays on the pointer.
 *
 * The backend sends "a click happened here", not "the click is over", so the
 * ripple is timed here. Per tab, because two agents can be clicking at once and
 * one settling must not cancel the other's.
 */
const CLICK_RIPPLE_MS = 300;
const clickResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Record where an agent's pointer is on a tab. Never decides visibility. */
export function setMcpCursor(
	backendTabId: string,
	cursor: { x: number; y: number; pressed?: boolean; clicking?: boolean }
): void {
	mcpCursorByBackendId = {
		...mcpCursorByBackendId,
		[backendTabId]: {
			x: cursor.x,
			y: cursor.y,
			pressed: !!cursor.pressed,
			clicking: !!cursor.clicking
		}
	};
}

/**
 * Let a click's ripple settle without moving the pointer.
 *
 * Separate from `setMcpCursor` so a stale timer can't drag the pointer back to
 * where it was when the click happened.
 */
export function clearMcpCursorClick(backendTabId: string): void {
	const current = mcpCursorByBackendId[backendTabId];
	if (!current?.clicking) return;
	mcpCursorByBackendId = {
		...mcpCursorByBackendId,
		[backendTabId]: { ...current, clicking: false }
	};
}

function forgetMcpCursor(backendTabId: string): void {
	const timer = clickResetTimers.get(backendTabId);
	if (timer) {
		clearTimeout(timer);
		clickResetTimers.delete(backendTabId);
	}

	if (!(backendTabId in mcpCursorByBackendId)) return;
	const next = { ...mcpCursorByBackendId };
	delete next[backendTabId];
	mcpCursorByBackendId = next;
}

function setMcpFocused(backendTabId: string, focused: boolean): void {
	if (focused === mcpFocusedBackendIds.has(backendTabId)) return;
	const next = new Set(mcpFocusedBackendIds);
	if (focused) next.add(backendTabId);
	else next.delete(backendTabId);
	mcpFocusedBackendIds = next;
}

/**
 * What the agent is doing on each controlled tab, in a few words.
 *
 * Held next to the control set rather than in the panel, and for the same
 * reason: the run carries on while the preview is closed, so the caption has to
 * be right the moment the user looks — not from the next action onwards.
 */
let mcpActivityByBackendId = $state<Record<string, string>>({});

export function getMcpActivity(backendTabId: string | null): string | null {
	return backendTabId ? (mcpActivityByBackendId[backendTabId] ?? null) : null;
}

function setMcpActivity(backendTabId: string, label: string | null): void {
	if ((mcpActivityByBackendId[backendTabId] ?? null) === label) return;

	const next = { ...mcpActivityByBackendId };
	if (label === null) delete next[backendTabId];
	else next[backendTabId] = label;
	mcpActivityByBackendId = next;
}

/**
 * Backend tab ids whose page is showing something full screen.
 *
 * Held here, not in the panel, for the same reason as the lock state: the
 * event can land while the preview is hidden, and the way out of a full screen
 * has to be on screen the moment the user looks — not only if they happened to
 * be watching when it started.
 */
let fullscreenBackendIds = $state(new Set<string>());

export function isBackendTabFullscreen(backendTabId: string | null): boolean {
	return !!backendTabId && fullscreenBackendIds.has(backendTabId);
}

function setBackendTabFullscreen(backendTabId: string, active: boolean): void {
	if (active === fullscreenBackendIds.has(backendTabId)) return;
	const next = new Set(fullscreenBackendIds);
	if (active) next.add(backendTabId);
	else next.delete(backendTabId);
	fullscreenBackendIds = next;
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
		// Recovered from the live backend tab, so a page refresh restores the tab
		// strip as it was instead of dropping to the placeholder until the user
		// reloads the page itself.
		favicon: backendTab.favicon,
		canGoBack: backendTab.canGoBack ?? false,
		canGoForward: backendTab.canGoForward ?? false,
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
	adoptBackendMcpState(backendTab);

	return frontendId;
}

/**
 * Take the backend's word for a tab's agent state.
 *
 * The authority for all four — lock, focus, caption, pointer — is the server,
 * and this is the only place a viewer adopts it wholesale. Used both when the
 * tab list is first built and when a viewer reconnects, because a `control-end`
 * that arrived while the socket was down would otherwise leave the lock, the
 * ring and the pointer on screen for the rest of the session.
 */
function adoptBackendMcpState(backendTab: ExistingTabInfo): void {
	setMcpControlled(backendTab.tabId, !!backendTab.isMcpControlled);
	setMcpFocused(backendTab.tabId, !!backendTab.isMcpFocused);
	setMcpActivity(backendTab.tabId, backendTab.isMcpControlled ? (backendTab.mcpActivity ?? null) : null);

	if (backendTab.mcpCursor) setMcpCursor(backendTab.tabId, backendTab.mcpCursor);
	else if (!backendTab.isMcpControlled) forgetMcpCursor(backendTab.tabId);
}

/**
 * Re-derive every tab's agent state from a fresh backend listing.
 *
 * Tabs the listing does not mention are gone, so anything remembered about
 * them is dropped too — a lock left behind by a missed event is exactly the
 * kind of state that otherwise survives until a restart.
 */
export function reconcileMcpState(backendTabs: ExistingTabInfo[]): void {
	const seen = new Set<string>();

	for (const backendTab of backendTabs) {
		seen.add(backendTab.tabId);
		adoptBackendMcpState(backendTab);
	}

	for (const tabId of [...mcpControlledBackendIds]) {
		if (!seen.has(tabId)) setMcpControlled(tabId, false);
	}
	for (const tabId of [...mcpFocusedBackendIds]) {
		if (!seen.has(tabId)) setMcpFocused(tabId, false);
	}
	for (const tabId of Object.keys(mcpCursorByBackendId)) {
		if (!seen.has(tabId)) forgetMcpCursor(tabId);
	}
	for (const tabId of Object.keys(mcpActivityByBackendId)) {
		if (!seen.has(tabId)) setMcpActivity(tabId, null);
	}
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
	// The backend's own "active tab" is a fallback only. It is one value shared
	// by everyone in the project, so honouring it over this user's snapshot
	// would land a returning viewer on whichever tab a colleague — or the agent
	// — happened to touch last, rather than the one they left.
	let backendActiveFrontendId: string | null = null;

	// 1. Replay snapshot slots in their original order so blank tabs survive and
	//    tab positions are preserved across the switch.
	if (snapshot && snapshot.length > 0) {
		for (const slot of snapshot) {
			if (slot.sessionId) {
				const backendTab = backendTabs.find((b) => b.tabId === slot.sessionId);
				if (!backendTab) continue; // Session is gone (browser closed) — drop the slot.
				usedBackendIds.add(backendTab.tabId);
				const frontendId = materializeBackendTab(backendTab);
				if (slot.isActive) activeFrontendId = frontendId;
				else if (backendTab.isActive) backendActiveFrontendId ??= frontendId;
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
		if (backendTab.isActive) backendActiveFrontendId ??= frontendId;
	}

	activeFrontendId ??= backendActiveFrontendId;

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
		mcpFocusedBackendIds = new Set();
		mcpActivityByBackendId = {};
		mcpCursorByBackendId = {};
		for (const timer of clickResetTimers.values()) clearTimeout(timer);
		clickResetTimers.clear();
		fullscreenBackendIds = new Set();
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

	/**
	 * A dropped socket means missed events, and the ones that matter most here
	 * are the retractions: a `control-end` nobody heard leaves the lock, the
	 * ring, the caption and the pointer on screen for a run that finished —
	 * indistinguishable, from the user's side, from the agent never letting go.
	 * Re-asking the server is the only honest recovery, and it is also where
	 * the backend sweeps up locks whose chat session died.
	 */
	onWsReconnect(() => {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;

		debug.log('preview', '🔁 [dock] Reconnected — re-reading agent state from backend');
		void getExistingTabs(projectId).then((result) => {
			// A project switch may have landed while this was in flight; its own
			// load() is authoritative and must not be overwritten by this answer.
			if (getActiveWorkspaceProjectId() !== projectId) return;
			if (result) reconcileMcpState(result.tabs);
		});
	});

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
		setMcpActivity(data.tabId, null);
		setBackendTabFullscreen(data.tabId, false);
		setMcpFocused(data.tabId, false);
		// The tab itself is gone, so unlike a release there is nothing left for a
		// remembered pointer position to be about.
		forgetMcpCursor(data.tabId);

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

	// Live tab metadata: the page's own title and favicon, plus whether
	// Back/Forward can go anywhere. Registered here rather than in the panel so
	// the dock's tab strip stays current even while the panel is unmounted.
	ws.on('preview:browser-tab-meta' as any, (data: any) => {
		if (!isEventForActiveProject(data)) return;

		const tab = previewTabManager.tabs.find((t) => t.sessionId === data.tabId);
		if (!tab) return;

		previewTabManager.updateTab(tab.id, {
			title: data.title || getTabTitle(data.url),
			favicon: data.favicon,
			canGoBack: data.canGoBack,
			canGoForward: data.canGoForward
		});
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
		setMcpActivity(data.browserTabId, null);
		setMcpFocused(data.browserTabId, false);
		// The remembered position stays. It decides nothing on its own — the
		// lock does — and keeping it means the next run picks up where this one
		// left off instead of starting from the middle of the page.

		// Toast when all tabs released.
		if (mcpControlledBackendIds.size === 0) {
			showInfo(
				'MCP Control Ended',
				'MCP agent released control. You can now interact with the browser.',
				4000
			);
		}
	});

	// Which locked tab an agent is working on right now. Registered here rather
	// than in the panel so the tab strip stays truthful even while the preview is
	// hidden — the marker has to be right the moment the user looks at it.
	ws.on('preview:browser-mcp-control-focus' as any, (data: any) => {
		if (!isEventForActiveProject(data)) return;
		setMcpFocused(data.browserTabId, !!data.focused);
	});

	// The caption for the agent's cursor.
	ws.on('preview:browser-mcp-activity' as any, (data: any) => {
		setMcpActivity(data.sessionId, data.label ?? null);
	});

	/**
	 * Where each agent's pointer is.
	 *
	 * Recorded for every tab the events mention, not only the one on screen:
	 * the panel may be closed, or showing a different tab, and the position
	 * still has to be right the moment someone looks. Held here rather than in
	 * the panel for the same reason the lock is.
	 */
	ws.on('preview:browser-mcp-cursor-position', (data) => {
		setMcpCursor(data.sessionId, { x: data.x, y: data.y, pressed: data.pressed });
	});

	ws.on('preview:browser-mcp-cursor-click', (data) => {
		setMcpCursor(data.sessionId, { x: data.x, y: data.y, clicking: true });
		const tabId = data.sessionId;
		const existing = clickResetTimers.get(tabId);
		if (existing) clearTimeout(existing);
		clickResetTimers.set(
			tabId,
			setTimeout(() => {
				clickResetTimers.delete(tabId);
				clearMcpCursorClick(tabId);
			}, CLICK_RIPPLE_MS)
		);
	});

	ws.on('preview:browser-fullscreen-state' as any, (data: any) => {
		if (!isEventForActiveProject(data)) return;
		setBackendTabFullscreen(data.tabId, !!data.active);
	});
}
