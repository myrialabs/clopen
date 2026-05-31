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
 *   - load()     kick async data loading; the switch barrier awaits this so all
 *                docks reveal together ("skeleton serempak")
 *
 * The coordinator is intentionally dependency-light: it never imports the dock
 * modules. Docks call `registerDock()` at module load and hand the coordinator
 * plain function references, so there are no import cycles.
 */

import ws from '$frontend/utils/ws';
import { appState } from '$frontend/stores/core/app.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';
import { debug } from '$shared/utils/logger';

const BLOB_VERSION = 1;

/** A per-project blob: dockId -> that dock's serialized slice. */
type WorkspaceBlob = {
	v: number;
	docks: Record<string, unknown>;
};

export interface DockController {
	/** Stable id; also the key under which this dock's slice lives in the blob. */
	id: string;
	/** Reset in-memory view data so old-project content can't flash through. */
	clear?: () => void;
	/** Produce this dock's serializable slice for the active project. */
	snapshot?: () => unknown;
	/** Apply a restored slice (or undefined when the project has no saved blob). */
	restore?: (slice: unknown) => void;
	/** Kick async data load for the project; the switch barrier awaits this. */
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

// The switch barrier is ref-counted so the project store can hold it up across
// the *entire* switch (sessions, edit-mode, …) while the coordinator also
// raises it for its own clear/restore/load phase. Skeletons stay visible until
// every holder releases — so all docks reveal together exactly once.
let barrierDepth = 0;

export function raiseSwitchBarrier(): void {
	barrierDepth += 1;
	appState.isSwitching = true;
}

export function lowerSwitchBarrier(): void {
	barrierDepth = Math.max(0, barrierDepth - 1);
	if (barrierDepth === 0) appState.isSwitching = false;
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
	// project was already flushed and docks are mid clear/restore, so a save now
	// would persist transient/cleared state. Real edits resume after the switch.
	if (appState.isSwitching) return;
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
 *   2. raise the switch barrier (docks show uniform skeletons)
 *   3. clear() every dock so no stale data can flash through
 *   4. fetch the new project's blob and restore() every dock's slice
 *   5. await every dock's load() so they're all ready before reveal
 *   6. drop the barrier — all docks reveal together
 *
 * Pass `null` to deactivate (e.g. when no project is selected).
 */
export async function activateProjectWorkspace(projectId: string | null): Promise<void> {
	// Nothing to do if we're already on this project.
	if (projectId === activeProjectId) return;

	// 1. Persist the project we're leaving.
	if (activeProjectId) {
		await flushPendingSave();
	}

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
		lowerSwitchBarrier();
		debug.log('workspace', `Workspace deactivated (was ${previousId ?? 'none'})`);
		return;
	}

	try {
		// 4. Restore slices from the (cached or server) blob.
		const blob = await fetchBlob(projectId);
		for (const dock of docks.values()) {
			try {
				dock.restore?.(blob.docks[dock.id]);
			} catch (err) {
				debug.error('workspace', `Dock ${dock.id} restore failed:`, err);
			}
		}

		// 5. Await every dock's critical data load so they reveal together.
		// Each load is bounded by a timeout: a single stalled dock (e.g. the
		// terminal waiting on a slow WS round-trip) must never wedge the barrier
		// up and leave the workspace stuck on "Loading…" forever. A timed-out dock
		// simply finishes loading in the background after reveal.
		await Promise.all(
			[...docks.values()].map(async (dock) => {
				try {
					await withTimeout(Promise.resolve(dock.load?.(projectId)), 8000, undefined);
				} catch (err) {
					debug.error('workspace', `Dock ${dock.id} load failed:`, err);
				}
			})
		);
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
}

// Drop a deleted project's cached blob automatically.
registerProjectCleanup((projectId) => {
	evictProjectWorkspace(projectId);
});
