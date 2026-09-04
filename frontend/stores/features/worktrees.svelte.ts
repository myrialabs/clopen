/**
 * Worktrees Store
 *
 * A worktree is an isolated copy of the project that sessions can run in, so
 * several tasks can proceed at once without touching each other's files.
 *
 * The active context is not stored separately — it is whatever the current chat
 * session is bound to. That keeps one fact in one place: switching context IS
 * switching to a session in that tree, and a session can never appear to run
 * somewhere other than where it actually runs.
 */

import ws from '$frontend/utils/ws';
import type { ChatSession } from '$shared/types/database/schema';
import { projectState, setProjectRootOverride } from '$frontend/stores/core/projects.svelte';
import { raiseSwitchBarrier, lowerSwitchBarrier } from '$frontend/stores/ui/project-workspace.svelte';
import { makeScopeKey, parseScopeKey } from '$shared/utils/workspace-scope';
import { debug } from '$shared/utils/logger';

export type WorktreeStatus = 'active' | 'applied' | 'archived';
export type WorktreeCloneMode = 'reflink' | 'copy';
export type TransferDirection = 'apply' | 'sync';
export type MergeResolution = 'source' | 'target' | 'merge';

export interface WorktreeSummary {
	id: string;
	project_id: string;
	name: string;
	slug: string;
	path: string;
	status: WorktreeStatus;
	clone_mode: WorktreeCloneMode;
	created_by?: string;
	created_at: string;
	last_opened_at?: string;
	last_applied_at?: string;
	sessionCount: number;
}

export interface WorktreeChange {
	path: string;
	status: 'added' | 'modified' | 'deleted';
	conflict: boolean;
	autoMergeable: boolean;
}

export interface WorktreeConflict extends WorktreeChange {
	sourceContent?: string;
	targetContent?: string;
}

export interface TransferPreview {
	direction: TransferDirection;
	changes: WorktreeChange[];
	conflicts: WorktreeConflict[];
}

interface WorktreeState {
	worktrees: WorktreeSummary[];
	/** Worktree the viewed session runs in; null = the main project tree. */
	activeId: string | null;
	isLoading: boolean;
	isCreating: boolean;
	isTransferring: boolean;
}

export const worktreeState = $state<WorktreeState>({
	worktrees: [],
	activeId: null,
	isLoading: false,
	isCreating: false,
	isTransferring: false
});

// ========================================
// DERIVED VALUES
// ========================================

export function activeWorktree(): WorktreeSummary | null {
	if (!worktreeState.activeId) return null;
	return worktreeState.worktrees.find((w) => w.id === worktreeState.activeId) ?? null;
}

export function worktreeById(id: string | null | undefined): WorktreeSummary | null {
	if (!id) return null;
	return worktreeState.worktrees.find((w) => w.id === id) ?? null;
}

/** Label for the context chip — the main tree has no worktree record. */
export function activeContextName(): string {
	return activeWorktree()?.name ?? 'Main';
}

export function isInWorktree(): boolean {
	return worktreeState.activeId !== null;
}

/**
 * Key for the workspace currently on screen.
 *
 * Terminal sessions and preview tabs are stored under this rather than the raw
 * project id, which is what keeps a worktree's shells and pages out of the main
 * tree's — and out of every other worktree's.
 */
export function currentScopeKey(): string {
	const projectId = projectState.currentProject?.id;
	if (!projectId) return '';
	return makeScopeKey(projectId, worktreeState.activeId);
}

// ========================================
// LOADING
// ========================================

export async function loadWorktrees(): Promise<void> {
	if (!projectState.currentProject) {
		worktreeState.worktrees = [];
		return;
	}

	worktreeState.isLoading = true;
	try {
		worktreeState.worktrees = (await ws.http('worktrees:list', {})) as WorktreeSummary[];
		// The docks have just loaded against the main tree, so that is the scope
		// the panels actually hold until a session says otherwise.
		lastAppliedScope ??= makeScopeKey(projectState.currentProject.id, null);
	} catch (error) {
		debug.error('worktree', 'Failed to load worktrees:', error);
		worktreeState.worktrees = [];
	} finally {
		worktreeState.isLoading = false;
	}
}

/**
 * Re-point the workspace at the tree the given session runs in.
 * Called on every session change, so the panels can never drift from the agent.
 */
/**
 * Scope the panels were last loaded for. A project switch is already handled by
 * the workspace coordinator's dock loads; only a change of *tree within the same
 * project* needs the panels re-keyed here.
 */
let lastAppliedScope: string | null = null;

export async function syncWorktreeContextFromSession(session: ChatSession | null): Promise<void> {
	const projectId = projectState.currentProject?.id;
	if (!projectId) {
		worktreeState.activeId = null;
		lastAppliedScope = null;
		return;
	}

	const previousScope = lastAppliedScope;
	const worktreeId = session?.worktree_id ?? null;
	worktreeState.activeId = worktreeId;

	const worktree = worktreeById(worktreeId);
	setProjectRootOverride(projectId, worktree?.path ?? null);

	// The server scopes terminals and preview tabs off the connection, so it has
	// to learn about the switch before either is asked for.
	await ws.setWorktree(worktree ? worktreeId : null);

	const scopeKey = currentScopeKey();
	lastAppliedScope = scopeKey;

	const samePreviousProject =
		previousScope !== null && parseScopeKey(previousScope).projectId === projectId;
	if (samePreviousProject && previousScope !== scopeKey) {
		await refreshRootDependentPanels();
	}
}

// ========================================
// CONTEXT SWITCHING
// ========================================

/**
 * Move the workspace into `worktreeId` (null = main).
 *
 * Reuses an existing active session in that tree when there is one so the user
 * comes back to their work rather than to an empty chat, and creates one only
 * when the tree has none.
 */
export async function switchWorktreeContext(worktreeId: string | null): Promise<void> {
	const project = projectState.currentProject;
	if (!project) return;
	if (worktreeState.activeId === worktreeId) return;

	const { sessionState, setCurrentSession, getSessionsForProject } = await import(
		'$frontend/stores/core/sessions.svelte'
	);

	// Barrier held across the swap: the panels between the old root and the new
	// session are showing another tree's files.
	raiseSwitchBarrier();
	try {
		const existing = getSessionsForProject(project.id)
			.filter((session) => !session.ended_at && (session.worktree_id ?? null) === worktreeId)
			.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];

		let target = existing ?? null;
		if (!target) {
			target = (await ws.http('sessions:get-shared', {
				forceNew: true,
				worktreeId
			})) as ChatSession;

			// The server also broadcasts the new session, so guard against holding
			// it twice.
			const existingIndex = sessionState.sessions.findIndex((s) => s.id === target?.id);
			if (existingIndex === -1) sessionState.sessions.push(target);
			else sessionState.sessions[existingIndex] = target;
		}

		await syncWorktreeContextFromSession(target);
		await setCurrentSession(target);
	} catch (error) {
		debug.error('worktree', 'Failed to switch worktree context:', error);
	} finally {
		lowerSwitchBarrier();
	}
}

/**
 * Re-key the panels that hold per-workspace state.
 *
 * A worktree switch keeps the same project, so the workspace coordinator's own
 * dock loads never fire — yet terminals and preview tabs belong to the tree, not
 * the project, and would otherwise still be the previous one's.
 */
async function refreshRootDependentPanels(): Promise<void> {
	const project = projectState.currentProject;
	if (!project) return;
	const scopeKey = currentScopeKey();

	try {
		const { syncGitStatusForProject } = await import('$frontend/stores/features/git-status.svelte');
		syncGitStatusForProject();
	} catch (error) {
		debug.warn('worktree', 'Git refresh after context switch failed:', error);
	}

	try {
		const { terminalProjectManager } = await import('$frontend/services/terminal');
		await terminalProjectManager.switchToProject(scopeKey, project.path);
	} catch (error) {
		debug.warn('worktree', 'Terminal switch after context switch failed:', error);
	}

	try {
		const { reloadPreviewTabsForScope } = await import(
			'$frontend/stores/features/preview-tabs-workspace.svelte'
		);
		await reloadPreviewTabsForScope(project.id, scopeKey);
	} catch (error) {
		debug.warn('worktree', 'Preview reload after context switch failed:', error);
	}
}

// ========================================
// MUTATIONS
// ========================================

export async function createWorktree(name: string): Promise<WorktreeSummary | null> {
	if (!projectState.currentProject) return null;

	worktreeState.isCreating = true;
	try {
		const result = await ws.http('worktrees:create', { name });
		await loadWorktrees();
		return result.worktree as WorktreeSummary;
	} catch (error) {
		debug.error('worktree', 'Failed to create worktree:', error);
		throw error;
	} finally {
		worktreeState.isCreating = false;
	}
}

export async function renameWorktree(id: string, name: string): Promise<void> {
	await ws.http('worktrees:rename', { id, name });
	await loadWorktrees();
}

/** Delete a worktree; the workspace falls back to main when it was the active one. */
export async function deleteWorktree(id: string): Promise<void> {
	const wasActive = worktreeState.activeId === id;
	await ws.http('worktrees:delete', { id });
	await loadWorktrees();
	if (wasActive) await switchWorktreeContext(null);
}

export async function fetchWorktreeStatus(
	id: string
): Promise<{ pendingChanges: number; diskKilobytes?: number }> {
	return (await ws.http('worktrees:status', { id })) as {
		pendingChanges: number;
		diskKilobytes?: number;
	};
}

export async function previewTransfer(
	id: string,
	direction: TransferDirection
): Promise<TransferPreview> {
	return (await ws.http('worktrees:preview-transfer', { id, direction })) as TransferPreview;
}

export async function runTransfer(
	id: string,
	direction: TransferDirection,
	resolutions: Record<string, MergeResolution> = {}
): Promise<{ written: number; deleted: number; skipped: number; failed: string[] }> {
	worktreeState.isTransferring = true;
	try {
		const result = await ws.http('worktrees:transfer', { id, direction, resolutions });
		await loadWorktrees();
		await refreshRootDependentPanels();
		return result;
	} finally {
		worktreeState.isTransferring = false;
	}
}

/** Bind an existing session to a worktree without changing the viewed session. */
export async function assignSessionToWorktree(
	sessionId: string,
	worktreeId: string | null
): Promise<void> {
	await ws.http('worktrees:assign-session', { sessionId, worktreeId });
}

// ========================================
// COLLABORATIVE EVENTS
// ========================================

let eventsBound = false;

export function initWorktreeEvents(): void {
	if (eventsBound) return;
	eventsBound = true;

	ws.on('worktrees:changed', (payload) => {
		if (payload.projectId !== projectState.currentProject?.id) return;
		worktreeState.worktrees = payload.worktrees as WorktreeSummary[];

		// A worktree the viewed session sits in may have just been deleted by
		// someone else; re-resolving keeps the root override honest.
		if (worktreeState.activeId && !worktreeById(worktreeState.activeId)) {
			void switchWorktreeContext(null);
		}
	});

	ws.on('worktrees:transferred', (payload) => {
		if (payload.projectId !== projectState.currentProject?.id) return;
		void refreshRootDependentPanels();
	});
}

export function clearWorktreeState(): void {
	worktreeState.worktrees = [];
	worktreeState.activeId = null;
	lastAppliedScope = null;
}
