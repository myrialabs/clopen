/**
 * Worktree database branching — the client half.
 *
 * "HAVE I ASKED YET" IS KEPT OUT OF THE REACTIVE GRAPH, in a plain module-level
 * set behind the `ensure*` methods. This is the rule `Task 4` paid for: every
 * fetch here writes its own `isLoading` cell synchronously, so an effect that
 * decides whether to fetch by reading a reactive cell subscribes to the very
 * thing it is about to change and re-runs itself forever. A failed fetch
 * deliberately does NOT clear the guard either — a provider that is down would
 * otherwise be hammered by whatever is on screen. The un-prefixed methods are
 * the forced path for the refresh controls, and they clear it.
 */

import ws from '$frontend/utils/ws';
import { projectState } from '$frontend/stores/core/projects.svelte';
import type {
	BranchParent,
	UnknownRemoteBranch,
	WorktreeBranchConfig,
	BranchSourceKind,
	BranchSuggestion,
	WorktreeBranchInfo,
	WorktreeBranchingState
} from '$shared/types/worktree-branching';
import { debug } from '$shared/utils/logger';

interface OrphanReport {
	tracked: WorktreeBranchInfo[];
	untracked: UnknownRemoteBranch[];
	/**
	 * Why the remote sweep could not run.
	 *
	 * Kept separate from an empty list on purpose: "no untracked branches" and
	 * "we could not look" are different answers, and rendering the second as the
	 * first is exactly the false reassurance this feature exists to avoid.
	 */
	sweepError: string | null;
}

interface BranchingStore {
	state: WorktreeBranchingState | null;
	isLoading: boolean;
	error: string | null;

	parents: BranchParent[];
	/** `<kind>:<id>` of the source the loaded parents belong to. */
	parentsSourceKey: string | null;
	isLoadingParents: boolean;
	parentsError: string | null;

	orphans: OrphanReport | null;
	isLoadingOrphans: boolean;

	/**
	 * The binding this project would get if it asked for one.
	 *
	 * `undefined` while unasked, `null` once known to be nothing — the same
	 * distinction the Supabase context cell makes, and for the same reason: a
	 * dialog that treated "not asked yet" as "nothing found" would flash the
	 * wrong empty state on every open.
	 */
	suggestion: BranchSuggestion | null | undefined;

	isSaving: boolean;
	busyBranchId: string | null;
}

export const branchingStore = $state<BranchingStore>({
	state: null,
	isLoading: false,
	error: null,

	parents: [],
	parentsSourceKey: null,
	isLoadingParents: false,
	parentsError: null,

	orphans: null,
	isLoadingOrphans: false,
	suggestion: undefined,

	isSaving: false,
	busyBranchId: null
});

/** Projects whose state has been requested this session. Never reactive. */
const asked = new Set<string>();
/** Accounts whose parent list has been requested. Never reactive. */
const askedParents = new Set<string>();

function currentProjectId(): string | null {
	return projectState.currentProject?.id ?? null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Load the branching state, whether or not it has been asked for before. */
export async function loadBranchingState(): Promise<void> {
	const projectId = currentProjectId();
	if (!projectId) return;

	asked.add(projectId);
	branchingStore.isLoading = true;
	branchingStore.error = null;
	try {
		branchingStore.state = (await ws.http('worktrees:branching-state', {})) as WorktreeBranchingState;
	} catch (error) {
		debug.error('worktree', 'Failed to load branching state:', error);
		branchingStore.error = messageOf(error);
	} finally {
		branchingStore.isLoading = false;
	}
}

/** Load it once. Safe to call from an effect — see the note at the top. */
export function ensureBranchingState(): void {
	const projectId = currentProjectId();
	if (!projectId || asked.has(projectId)) return;
	void loadBranchingState();
}

export async function loadParents(source: BranchSourceRef): Promise<void> {
	const key = sourceKey(source);
	askedParents.add(key);
	branchingStore.isLoadingParents = true;
	branchingStore.parentsError = null;
	try {
		branchingStore.parents = (await ws.http('worktrees:branch-parents', source)) as BranchParent[];
		branchingStore.parentsSourceKey = key;
	} catch (error) {
		branchingStore.parents = [];
		branchingStore.parentsSourceKey = key;
		branchingStore.parentsError = messageOf(error);
	} finally {
		branchingStore.isLoadingParents = false;
	}
}

/** A source, as both routes and the cache key want it. */
export interface BranchSourceRef {
	sourceKind: BranchSourceKind;
	sourceId: string;
}

export function sourceKey(source: BranchSourceRef): string {
	return `${source.sourceKind}:${source.sourceId}`;
}

export function ensureParents(source: BranchSourceRef | null): void {
	if (!source?.sourceId || askedParents.has(sourceKey(source))) return;
	void loadParents(source);
}

export async function saveBinding(input: {
	sourceKind: BranchSourceKind;
	sourceId: string;
	parentRef: string;
	parentName: string;
	config: Partial<WorktreeBranchConfig>;
}): Promise<void> {
	branchingStore.isSaving = true;
	try {
		await ws.http('worktrees:branching-save', input);
		await loadBranchingState();
	} finally {
		branchingStore.isSaving = false;
	}
}

export async function clearBinding(): Promise<void> {
	branchingStore.isSaving = true;
	try {
		await ws.http('worktrees:branching-clear', {});
		await loadBranchingState();
	} finally {
		branchingStore.isSaving = false;
	}
}

/** What this project's worktrees could copy, worked out from its own files. */
export async function loadSuggestion(): Promise<void> {
	try {
		branchingStore.suggestion = (await ws.http(
			'worktrees:branch-suggest',
			{}
		)) as BranchSuggestion | null;
	} catch (error) {
		// A guess that could not be made is not a failure worth a banner: the
		// setup dialog is still there, and the checkbox simply does not appear.
		debug.warn('worktree', 'Could not suggest a branch source:', error);
		branchingStore.suggestion = null;
	}
}

export function ensureSuggestion(): void {
	if (branchingStore.suggestion !== undefined) return;
	void loadSuggestion();
}

export async function loadOrphans(): Promise<void> {
	branchingStore.isLoadingOrphans = true;
	try {
		branchingStore.orphans = (await ws.http('worktrees:branch-orphans', {})) as OrphanReport;
	} catch (error) {
		// The route already tolerates a failed remote sweep, so reaching here
		// means the whole call failed — reported as a sweep error rather than as
		// an empty list, for the reason `OrphanReport.sweepError` exists.
		branchingStore.orphans = { tracked: [], untracked: [], sweepError: messageOf(error) };
	} finally {
		branchingStore.isLoadingOrphans = false;
	}
}

export async function deleteOrphan(branchId: string): Promise<void> {
	branchingStore.busyBranchId = branchId;
	try {
		await ws.http('worktrees:branch-delete', { branchId });
		await loadOrphans();
	} finally {
		branchingStore.busyBranchId = null;
	}
}

export async function forgetOrphan(branchId: string): Promise<void> {
	branchingStore.busyBranchId = branchId;
	try {
		await ws.http('worktrees:branch-forget', { branchId });
		await loadOrphans();
	} finally {
		branchingStore.busyBranchId = null;
	}
}

export async function deleteUntracked(input: {
	sourceKind: BranchSourceKind;
	sourceId: string;
	parentRef: string;
	branchRef: string;
}): Promise<void> {
	branchingStore.busyBranchId = input.branchRef;
	try {
		await ws.http('worktrees:branch-delete-remote', input);
		await loadOrphans();
	} finally {
		branchingStore.busyBranchId = null;
	}
}

export async function rewriteBranchEnv(branchId: string): Promise<void> {
	branchingStore.busyBranchId = branchId;
	try {
		await ws.http('worktrees:branch-rewrite-env', { branchId });
		await loadBranchingState();
	} finally {
		branchingStore.busyBranchId = null;
	}
}

export function registerBranchingListeners(): void {
	ws.on('worktrees:branching-changed', (payload) => {
		if (payload.projectId !== currentProjectId()) return;
		branchingStore.state = payload.state as WorktreeBranchingState;
		asked.add(payload.projectId);
	});
}

/** Drop everything, including the guards — a different project asks again. */
export function clearBranchingState(): void {
	branchingStore.state = null;
	branchingStore.error = null;
	branchingStore.parents = [];
	branchingStore.parentsSourceKey = null;
	branchingStore.suggestion = undefined;
	branchingStore.parentsError = null;
	branchingStore.orphans = null;
	asked.clear();
	askedParents.clear();
}
