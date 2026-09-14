/**
 * The violet AI-change marker, in one place.
 *
 * Files and Git both draw it, and they must agree: a file marked in the tree
 * and unmarked in the changes list is worse than no marker at all. The rules
 * themselves live in ai-change-index.ts, free of stores so they can be tested;
 * this is only the wiring that hands them the current state.
 */

import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
import { aiChangesForPath } from '$frontend/stores/features/ai-changes.svelte';
import { markerStateFor, describeTurns, type AiMarkerState } from '$frontend/utils/ai-change-index';

export type { AiMarkerState };

export function aiMarkerState(absolutePath: string): AiMarkerState {
	return markerStateFor(
		aiChangesForPath(absolutePath),
		gitStatusState.isRepo,
		gitStatusState.unstagedSet
	);
}

/** One sentence for the dot's tooltip: what happened, and what to do about it. */
export function aiMarkerTooltip(absolutePath: string): string {
	const changes = aiChangesForPath(absolutePath);
	if (!changes) return '';
	return `${describeTurns(changes)} — click to review it.`;
}
