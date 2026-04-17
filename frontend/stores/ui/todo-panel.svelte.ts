/**
 * Todo Panel UI State
 *
 * Persists the task progress panel expand/collapse preference via server-side user state.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface TodoPanelState {
	isExpanded: boolean;
}

const defaults: TodoPanelState = {
	isExpanded: true,
};

export const todoPanelState = $state<TodoPanelState>({ ...defaults });

/** Apply server-restored state during initialization. */
export function applyTodoPanelState(saved: Partial<TodoPanelState> | null): void {
	if (saved && typeof saved === 'object') {
		Object.assign(todoPanelState, { ...defaults, ...saved });
		debug.log('workspace', 'Applied server todo panel state');
	}
}

/** Persist current state to server (fire-and-forget). */
export function saveTodoPanelState(): void {
	ws.http('user:save-state', { key: 'todoPanelState', value: { ...todoPanelState } }).catch((err) => {
		debug.error('workspace', 'Failed to save todo panel state:', err);
	});
}
