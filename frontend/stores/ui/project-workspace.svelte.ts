/**
 * Project Workspace Coordinator
 *
 * Owns the per-project workspace blob (one JSON document per project, persisted
 * server-side via `workspace:get/save-state`) and orchestrates a single,
 * coordinated transition when the active project changes.
 *
 * Each dock (layout, git, preview, terminal, chat, …) registers a
 * `DockController` describing how to:
 *   - clear()    tear down its in-memory view data so the previous project's
 *                content can never flash through during a switch
 *   - snapshot() produce its serializable slice of the active project's blob
 *   - restore()  apply a restored slice before the new project is revealed
 *   - load()     kick async data loading; this runs AFTER the reveal, behind the
 *                dock's panel skeleton, so one slow dock can't hold up the rest
 *
 * The transition is split in two on purpose. The switch barrier covers only the
 * structural swap — the phase where any pixel on screen would belong to the
 * previous project. Data loading happens after, per panel, so switch latency is
 * bounded by one round trip rather than the sum of every subsystem's load.
 *
 * The coordinator is intentionally dependency-light: it never imports the dock
 * modules. Docks call `registerDock()` at module load and hand the coordinator
 * plain function references, so there are no import cycles.
 */

import ws from '$frontend/utils/ws';
import { appState } from '$frontend/stores/core/app.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';
import { debug } from '$shared/utils/logger';
// Type-only import: the layout dock lives in workspace.svelte and imports this
// module at runtime, so anything but `import type` here would be a cycle.
import type { PanelId } from '$frontend/stores/ui/workspace.svelte';

const BLOB_VERSION = 1;

/** A per-project blob: dockId -> that dock's serialized slice. */
type WorkspaceBlob = {
	v: number;
	docks: Record<string, unknown>;
};

export interface DockController {
	/** Stable id; also the key under which this dock's slice lives in the blob. */
	id: string;
	/**
	 * Panel this dock's data belongs to. While `load()` runs, that panel shows a
	 * skeleton (see `isPanelLoading`) instead of an empty state.
	 */
	panelId?: PanelId;
	/** Reset in-memory view data so old-project content can't flash through. */
	clear?: () => void;
	/** Produce this dock's serializable slice for the active project. */
	snapshot?: () => unknown;
	/** Apply a restored slice (or undefined when the project has no saved blob). */
	restore?: (slice: unknown) => void;
	/** Kick async data load for the project; runs after reveal, behind a skeleton. */
	load?: (projectId: string) => Promise<void> | void;
}

// In-memory cache of each project's blob so repeat switches are instant.
const cache = new Map<string, WorkspaceBlob>();
const docks = new Map<string, DockController>();

/**
 * Resolve to the promise's value, or to `fallback` if it doesn't settle in time.
 * Guarantees the switch sequence can never hang on a stalled socket and leave
 * the loading barrier stuck up (which would freeze the workspace).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const finish = (v: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => finish(fallback), ms);
		promise.then(finish, () => finish(fallback));
	});
}

let activeProjectId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// True from the moment a switch starts until every dock has finished hydrating.
// Spans past the barrier now that docks load after reveal, and suppresses saves
// that would otherwise persist a half-loaded workspace.
let settling = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Upper bound on any post-reveal loading state. Nothing that hides UI or blocks
 * persistence may depend solely on a promise resolving: a socket that never
 * answers would otherwise leave a panel on "Loading…" or stop workspace saves
 * for the rest of the session, with no way back short of a refresh.
 */
const LOAD_SAFETY_TIMEOUT_MS = 15_000;

function markSettling(): void {
	settling = true;
	if (settleTimer) clearTimeout(settleTimer);
	settleTimer = setTimeout(() => {
		settleTimer = null;
		settling = false;
	}, LOAD_SAFETY_TIMEOUT_MS);
}

function markSettled(): void {
	if (settleTimer) clearTimeout(settleTimer);
	settleTimer = null;
	settling = false;
}

// The switch barrier is ref-counted so the project store can hold it up across
// the structural part of a switch while the coordinator also raises it for its
// own clear/restore phase. It covers ONLY the phase during which showing
// anything would mean showing the wrong project — data loading happens after
// reveal, behind each panel's own skeleton (see `beginPanelLoad`).
let barrierDepth = 0;

export function raiseSwitchBarrier(): void {
	barrierDepth += 1;
	appState.isSwitching = true;
}

export function lowerSwitchBarrier(): void {
	barrierDepth = Math.max(0, barrierDepth - 1);
	if (barrierDepth === 0) appState.isSwitching = false;
}

// ============================================================
// SWITCH GENERATION
// ============================================================
//
// Every project switch takes a token. Any state write that happens after an
// `await` must first check it still owns the current token, otherwise a switch
// the user already abandoned (A→B→C in quick succession) finishes late and
// overwrites the project they actually landed on. Without this, rapid switching
// left panels showing a mix of two projects — or stuck on a skeleton, because a
// superseded run's barrier release never matched its raise.

let switchToken = 0;

/** Start a new switch generation and return its token. */
export function beginProjectSwitch(): number {
	switchToken += 1;
	// A new switch supersedes every panel load still attributed to the old one.
	clearPanelLoads();
	return switchToken;
}

/** Whether `token` is still the newest switch (i.e. its work is still wanted). */
export function isCurrentSwitch(token: number): boolean {
	return token === switchToken;
}

// ============================================================
// PER-PANEL LOADING
// ============================================================
//
// The switch barrier hides every panel at once, so it must be short. Everything
// that loads after reveal registers here instead, and the panel renders a
// skeleton for as long as it is registered. This is what stops a panel from
// showing "No files in project" / "Not a git repository" while its data is
// still in flight — an empty state now means genuinely empty, never "not
// loaded yet".

// The holder counts live in a PLAIN map, deliberately outside the reactive
// graph. `beginPanelLoad` is called from inside component `$effect`s, and a
// read-modify-write of reactive state there (`loads[id] = loads[id] + 1`) makes
// the effect a reader of the very state it writes — it invalidates itself and
// Svelte aborts with `effect_update_depth_exceeded`. Keeping the counter
// non-reactive means registering a load only ever WRITES reactive state.
const panelLoadCounts = new Map<PanelId, number>();

// The reactive mirror consumers read. Keys are declared up front and only ever
// reassigned, never added or deleted: on a `$state` object a new/removed key
// invalidates every reader of the object, so one panel starting to load would
// otherwise re-render all the others.
const panelLoading = $state<Record<PanelId, boolean>>({
	chat: false,
	files: false,
	git: false,
	terminal: false,
	preview: false
});

function setPanelLoadCount(panelId: PanelId, count: number): void {
	if (count > 0) panelLoadCounts.set(panelId, count);
	else panelLoadCounts.delete(panelId);
	panelLoading[panelId] = count > 0;
}

/**
 * Mark `panelId` as loading until the returned release function is called.
 * Safe to nest; the panel stays in its loading state until the last holder
 * releases. Releasing is idempotent, and a release belonging to a superseded
 * switch is discarded rather than decrementing the new switch's count.
 */
export function beginPanelLoad(panelId: PanelId, token = switchToken): () => void {
	if (token !== switchToken) return () => {};
	setPanelLoadCount(panelId, (panelLoadCounts.get(panelId) ?? 0) + 1);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		clearTimeout(safety);
		if (token !== switchToken) return;
		setPanelLoadCount(panelId, (panelLoadCounts.get(panelId) ?? 1) - 1);
	};

	// A caller that never releases (a request that never answers, a component
	// torn down mid-load) must not leave its panel showing "Loading…" forever.
	const safety = setTimeout(release, LOAD_SAFETY_TIMEOUT_MS);
	return release;
}

/** Whether `panelId` is waiting on data and should render a skeleton. */
export function isPanelLoading(panelId: PanelId): boolean {
	return panelLoading[panelId];
}

/** Drop every registered panel load (a new switch supersedes all of them). */
function clearPanelLoads(): void {
	for (const panelId of panelLoadCounts.keys()) panelLoading[panelId] = false;
	panelLoadCounts.clear();
}

/** Register a dock controller. Idempotent per id (last registration wins). */
export function registerDock(controller: DockController): void {
	docks.set(controller.id, controller);
}

/** The project whose workspace is currently active (null when none). */
export function getActiveWorkspaceProjectId(): string | null {
	return activeProjectId;
}

// ============================================================
// PERSISTENCE
// ============================================================

async function fetchBlob(projectId: string): Promise<WorkspaceBlob> {
	const cached = cache.get(projectId);
	if (cached) return cached;

	let blob: WorkspaceBlob = { v: BLOB_VERSION, docks: {} };
	try {
		const res = await withTimeout(
			ws.http('workspace:get-state', { projectId }),
			4000,
			{ state: null }
		);
		if (res?.state) {
			const parsed = JSON.parse(res.state) as WorkspaceBlob;
			if (parsed && typeof parsed === 'object' && parsed.docks) {
				blob = { v: parsed.v ?? BLOB_VERSION, docks: parsed.docks };
			}
		}
	} catch (err) {
		debug.error('workspace', 'Failed to fetch workspace blob:', err);
	}
	cache.set(projectId, blob);
	return blob;
}

/** Build the active project's blob from every dock's current snapshot. */
function snapshotActiveBlob(): WorkspaceBlob | null {
	if (!activeProjectId) return null;
	const slices: Record<string, unknown> = {};
	for (const dock of docks.values()) {
		if (!dock.snapshot) continue;
		try {
			const slice = dock.snapshot();
			if (slice !== undefined) slices[dock.id] = slice;
		} catch (err) {
			debug.error('workspace', `Dock ${dock.id} snapshot failed:`, err);
		}
	}
	return { v: BLOB_VERSION, docks: slices };
}

/** Persist the active project's blob to the server (called debounced). */
async function flushActiveBlob(): Promise<void> {
	const projectId = activeProjectId;
	if (!projectId) return;
	const blob = snapshotActiveBlob();
	if (!blob) return;
	cache.set(projectId, blob);
	try {
		await withTimeout(
			ws.http('workspace:save-state', { projectId, state: JSON.stringify(blob) }),
			4000,
			{ ok: false }
		);
	} catch (err) {
		debug.error('workspace', 'Failed to save workspace blob:', err);
	}
}

/**
 * Request a debounced save of the active project's workspace blob.
 * Dock mutation handlers call this instead of persisting directly.
 */
export function requestWorkspaceSave(): void {
	if (!activeProjectId) return;
	// Ignore reactive saves triggered while a switch is in flight — the leaving
	// project was already flushed and docks are mid clear/restore/hydrate, so a
	// save now would persist transient/cleared state. `settling` extends this
	// past the reveal, because docks keep hydrating after the barrier drops.
	// Real edits resume once everything has landed.
	if (appState.isSwitching || settling) return;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		flushActiveBlob();
	}, 400);
}

/** Flush any pending save immediately (e.g. before switching away). */
async function flushPendingSave(): Promise<void> {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	await flushActiveBlob();
}

// ============================================================
// SWITCH COORDINATION
// ============================================================

/**
 * Activate a project's workspace with a single coordinated transition.
 *
 * Sequence:
 *   1. flush the outgoing project's blob so nothing is lost
 *   2. raise the switch barrier (panels show a uniform "Loading…")
 *   3. clear() every dock so no stale data can flash through
 *   4. fetch the new project's blob and restore() every dock's slice
 *   4b. run `onAfterRestore` (see below)
 *   5. START every dock's load() WITHOUT awaiting it, each registered against
 *      its panel so that panel renders a skeleton until its data lands
 *   6. drop the barrier — the workspace is revealed as soon as it is structurally
 *      correct, not once every byte has arrived
 *
 * Step 5 used to await all loads under the barrier. That made a switch cost the
 * sum of every dock's slowest round-trip with the whole workspace blanked, which
 * on a large project read as "switching projects is very slow". Loading behind
 * per-panel skeletons costs the same wall-clock but the workspace is usable —
 * and correct — almost immediately, and a slow dock only holds up its own panel.
 *
 * `onAfterRestore` runs synchronously between the dock restore loop (4) and the
 * load phase (5) — i.e. in the SAME synchronous block as `applyLayoutSlice`,
 * which the `layout` dock's restore() just ran. The caller uses it to publish
 * the new `projectState.currentProject`, so Svelte batches the layout swap and
 * the current-project change into one flush: panels that remount on the layout
 * swap mount ONCE, already pointing at the new project, with their dock
 * view-state already restored. Setting the current project any later (after the
 * await below) lets the layout swap flush alone first — remounting live panels
 * against the OLD project, which then race a reload and can leave them blank
 * until a full refresh. (The refresh path has no such gap: it activates the
 * workspace behind the loading screen before any panel mounts.)
 *
 * Pass `null` to deactivate (e.g. when no project is selected).
 */
export async function activateProjectWorkspace(
	projectId: string | null,
	onAfterRestore?: () => void,
	token = switchToken
): Promise<void> {
	// Nothing to do if we're already on this project.
	if (projectId === activeProjectId) return;

	// 1. Persist the project we're leaving — but only from a settled workspace.
	// Mid-transition its docks are cleared or half-hydrated, and the switch that
	// put them in that state already flushed it, so snapshotting now would
	// overwrite a good blob with a transient one.
	if (activeProjectId && !settling) {
		await flushPendingSave();
	}
	if (!isCurrentSwitch(token)) return;
	markSettling();

	const previousId = activeProjectId;
	activeProjectId = projectId;

	// 2. Raise the barrier.
	raiseSwitchBarrier();

	// 3. Clear every dock so the previous project's content can't leak.
	for (const dock of docks.values()) {
		try {
			dock.clear?.();
		} catch (err) {
			debug.error('workspace', `Dock ${dock.id} clear failed:`, err);
		}
	}

	if (!projectId) {
		markSettled();
		lowerSwitchBarrier();
		debug.log('workspace', `Workspace deactivated (was ${previousId ?? 'none'})`);
		return;
	}

	try {
		// 4. Restore slices from the (cached or server) blob.
		const blob = await fetchBlob(projectId);
		if (!isCurrentSwitch(token)) return;

		for (const dock of docks.values()) {
			try {
				dock.restore?.(blob.docks[dock.id]);
			} catch (err) {
				debug.error('workspace', `Dock ${dock.id} restore failed:`, err);
			}
		}

		// 4b. Publish the new active project in the SAME synchronous block as the
		// layout swap above, so Svelte batches them: live panels remount once,
		// already on the new project, with view-state restored. See the doc above.
		try {
			onAfterRestore?.();
		} catch (err) {
			debug.error('workspace', 'onAfterRestore failed:', err);
		}

		// 5. Kick each dock's data load WITHOUT blocking the reveal. The load is
		// registered against the dock's panel, so that panel shows a skeleton
		// until its data lands while every other panel is already interactive.
		// The timeout only bounds how long a stalled dock may hold its own
		// skeleton up — it can no longer wedge the whole workspace.
		const loads = [...docks.values()].map(async (dock) => {
			if (!dock.load) return;
			const release = dock.panelId ? beginPanelLoad(dock.panelId, token) : null;
			try {
				await withTimeout(Promise.resolve(dock.load(projectId)), 8000, undefined);
			} catch (err) {
				debug.error('workspace', `Dock ${dock.id} load failed:`, err);
			} finally {
				release?.();
			}
		});

		// Resume workspace saves only once the loads settle: a save fired while a
		// dock is still hydrating would snapshot its half-restored state.
		void Promise.all(loads).then(() => {
			if (isCurrentSwitch(token)) markSettled();
		});
	} finally {
		// 6. Reveal (drops to hidden only once all barrier holders release).
		lowerSwitchBarrier();
		debug.log('workspace', `Workspace activated for project ${projectId}`);
	}
}

/**
 * Drop a project's cached blob (e.g. when the project is deleted).
 */
export function evictProjectWorkspace(projectId: string): void {
	cache.delete(projectId);
	if (activeProjectId === projectId) {
		activeProjectId = null;
	}
}

/** Clear all cached workspace blobs (e.g. on "Clear All Data"). */
export function clearAllWorkspaceCache(): void {
	cache.clear();
	activeProjectId = null;
	markSettled();
}

// Drop a deleted project's cached blob automatically.
registerProjectCleanup((projectId) => {
	evictProjectWorkspace(projectId);
});
