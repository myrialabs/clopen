/**
 * AI Changes Store
 *
 * What the current chat changed on disk, turn by turn. Drives the violet dot in
 * Files and Git, the AI gutter in the editor, and the Changes tab of the
 * checkpoint modal — one store so those three can never tell different stories.
 *
 * The data comes from checkpoint snapshots, NOT from Edit/Write tool calls.
 * Reading the transcript meant a change only counted when it arrived as a tool
 * the frontend recognised, which silently missed everything written through
 * Bash, apply_patch, a notebook edit, a formatter, or a sub-agent (whose tool
 * inputs are stripped on the wire). A snapshot is a gitignore-aware disk diff,
 * so it sees the result regardless of how it was produced — including a tool
 * that does not exist yet.
 *
 * The honest reading of a turn's file list is "changed while this turn ran",
 * which can include a file the user saved themselves mid-turn. Every label in
 * the UI says it that way rather than claiming authorship.
 *
 * Scope is the chat session being viewed: these markers exist to explain what
 * this conversation did, and they are cleared when the conversation changes.
 */

import { projectState } from '$frontend/stores/core/projects.svelte';
import { getSessionProcessState } from '$frontend/stores/core/app.svelte';
import { currentScopeKey } from '$frontend/stores/features/worktrees.svelte';
import ws, { onWsReconnect } from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import {
	indexTurnsByPath,
	turnIdOf,
	PENDING_TURN_ID,
	type TurnChanges,
	type TurnFileChange,
	type PathChanges
} from '$frontend/utils/ai-change-index';

export {
	PENDING_TURN_ID,
	turnIdOf as turnId,
	type TurnChanges,
	type TurnFileChange,
	type TurnFileStatus,
	type PathChanges,
	type AiMarkerState
} from '$frontend/utils/ai-change-index';

interface AiChangesState {
	/** Session these changes belong to; null when nothing is loaded. */
	sessionId: string | null;
	/** Settled turns, newest first, plus the in-flight turn when there is one. */
	turns: TurnChanges[];
	/** Absolute path → what happened to it. The panels' lookup table. */
	byPath: Map<string, PathChanges>;
	loading: boolean;
}

export const aiChangesState = $state<AiChangesState>({
	sessionId: null,
	turns: [],
	byPath: new Map(),
	loading: false
});

// ========================================
// DERIVED INDEX
// ========================================

/** Rebuild the path index from the turn list. Turns are already newest-first. */
function reindex(): void {
	aiChangesState.byPath = indexTurnsByPath(
		aiChangesState.turns,
		projectState.currentProject?.path ?? ''
	);
}

/** Everything known about one absolute path, or null when it was untouched. */
export function aiChangesForPath(absolutePath: string): PathChanges | null {
	return aiChangesState.byPath.get(absolutePath) ?? null;
}

/** The turns that touched one path, newest first. */
export function turnsForPath(absolutePath: string): TurnChanges[] {
	return aiChangesState.byPath.get(absolutePath)?.turns ?? [];
}

// ========================================
// LOADING
// ========================================

/**
 * In-flight generation counter. A session switch while a fetch is in the air
 * must not let the old session's answer land on the new session's panels.
 */
let generation = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop everything. Called when there is no session to describe. */
export function clearAiChanges(): void {
	generation++;
	if (pendingTimer) {
		clearTimeout(pendingTimer);
		pendingTimer = null;
	}
	aiChangesState.sessionId = null;
	aiChangesState.turns = [];
	aiChangesState.byPath = new Map();
	aiChangesState.loading = false;
}

/**
 * Load every settled turn of a session, then fold in whatever the running turn
 * has changed so far.
 */
export async function loadAiChanges(sessionId: string | null): Promise<void> {
	if (!sessionId) {
		clearAiChanges();
		return;
	}

	const mine = ++generation;
	aiChangesState.sessionId = sessionId;
	aiChangesState.loading = true;

	try {
		const response = await ws.http('snapshot:list-turn-changes', { sessionId });
		if (mine !== generation) return;

		aiChangesState.turns = response.turns.map((turn) => ({
			checkpointMessageId: turn.checkpointMessageId,
			turnIndex: turn.turnIndex,
			timestamp: turn.timestamp,
			promptText: turn.promptText,
			files: turn.files as TurnFileChange[]
		}));
		reindex();
	} catch (error) {
		if (mine !== generation) return;
		debug.error('snapshot', 'Failed to load AI changes:', error);
		aiChangesState.turns = [];
		aiChangesState.byPath = new Map();
	} finally {
		if (mine === generation) aiChangesState.loading = false;
	}

	await refreshPendingChanges();
}

/**
 * Re-read the running turn's changes.
 *
 * Debounced, because the trigger is the file watcher and a build step can emit
 * hundreds of events in a second. The reply replaces the in-flight turn
 * wholesale — it is a delta against the same baseline every time, so merging
 * would only let a reverted file linger.
 */
function refreshPendingChanges(delay = 0): Promise<void> {
	if (pendingTimer) {
		clearTimeout(pendingTimer);
		pendingTimer = null;
	}
	if (delay === 0) return readPendingChanges();

	return new Promise((resolve) => {
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			void readPendingChanges().then(resolve);
		}, delay);
	});
}

async function readPendingChanges(): Promise<void> {
	const sessionId = aiChangesState.sessionId;
	if (!sessionId) return;

	const mine = generation;
	try {
		const response = await ws.http('snapshot:get-pending-changes', { sessionId });
		if (mine !== generation) return;

		const settled = aiChangesState.turns.filter((turn) => turn.checkpointMessageId !== null);
		if (response.files.length === 0) {
			aiChangesState.turns = settled;
		} else {
			aiChangesState.turns = [
				{
					checkpointMessageId: null,
					turnIndex: null,
					timestamp: new Date().toISOString(),
					promptText: 'In progress',
					files: response.files as TurnFileChange[]
				},
				...settled
			];
		}
		reindex();
	} catch (error) {
		if (mine !== generation) return;
		// A turn in flight is the least important thing to be right about, and
		// the capture at turn end corrects it either way.
		debug.warn('snapshot', 'Failed to read pending AI changes:', error);
	}
}

// ========================================
// LIVE UPDATES
// ========================================

/** How long to let file events settle before asking for the running turn. */
const PENDING_DEBOUNCE_MS = 600;

let initialized = false;

/**
 * Subscribe to the two events that move this data, once per app.
 *
 * Deliberately app-level rather than panel-level: the Changes tab, the editor
 * gutter and the two panels all read this store, and tying its freshness to
 * whichever of them happened to be mounted is how the old indicators ended up
 * only updating when the chat panel was open.
 */
export function initAiChanges(): void {
	if (initialized) return;
	initialized = true;

	// A turn ended and its snapshot landed: the settled answer is now available
	// and replaces whatever the in-flight poll had guessed.
	ws.on('snapshot:captured', (payload: { chatSessionId: string }) => {
		if (payload.chatSessionId !== aiChangesState.sessionId) return;
		void loadAiChanges(aiChangesState.sessionId);
	});

	// Files moved on disk. Only worth a request while this session is actually
	// running — otherwise the change is the user's own editing, which belongs to
	// no turn and must not light up an AI marker.
	ws.on('files:changed', (payload: { projectId: string; changes: unknown[] }) => {
		if (payload.projectId !== currentScopeKey()) return;
		if (payload.changes.length === 0) return;
		const sessionId = aiChangesState.sessionId;
		if (!sessionId || !getSessionProcessState(sessionId).isLoading) return;
		void refreshPendingChanges(PENDING_DEBOUNCE_MS);
	});

	// Events sent while the socket was down reached nobody, so re-read rather
	// than waiting for the next unrelated write.
	onWsReconnect(() => {
		if (aiChangesState.sessionId) void loadAiChanges(aiChangesState.sessionId);
	});
}

// ========================================
// REVEAL
// ========================================

/**
 * Ask a viewer to focus one file's changes from a given turn.
 *
 * Keyed by (path, turn) rather than by a tool_use id: a turn exists for every
 * change regardless of which tool made it, and it survives a refetch, which a
 * position in a rebuilt list does not.
 */
export interface AiRevealRequest {
	absolutePath: string;
	turnId: string;
}

let revealListeners: Array<(request: AiRevealRequest) => void> = [];
let pendingReveal: AiRevealRequest | null = null;

export function requestAiReveal(absolutePath: string, turn: string): void {
	pendingReveal = { absolutePath, turnId: turn };
	for (const listener of revealListeners) listener(pendingReveal);
}

export function onAiReveal(listener: (request: AiRevealRequest) => void): () => void {
	revealListeners.push(listener);
	return () => {
		revealListeners = revealListeners.filter((l) => l !== listener);
	};
}

/** Consume a reveal aimed at this path, or null when it was meant elsewhere. */
export function consumeAiReveal(absolutePath: string): string | null {
	if (pendingReveal && pendingReveal.absolutePath === absolutePath) {
		const turn = pendingReveal.turnId;
		pendingReveal = null;
		return turn;
	}
	return null;
}
