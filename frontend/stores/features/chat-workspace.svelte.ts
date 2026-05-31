/**
 * Chat Dock Workspace State
 *
 * Per-session chat reading position (scroll anchor) for the active project.
 * Chat renders a virtual window with auto-load, so a raw scrollTop is
 * meaningless across remounts — we remember an ANCHOR message (the one at the
 * top of the viewport) plus its pixel offset, and re-align to it on return.
 * An at-bottom session always restores to the bottom as before.
 *
 * Previously this lived in an in-memory map inside ChatMessages.svelte, which
 * survived project switches within a session but was lost on a full browser
 * refresh. It is now snapshot/restored through the project workspace coordinator
 * (a `chat` dock) so the reading position is persisted server-side per project —
 * single source of truth in DB, surviving refresh and following the user across
 * devices, exactly like the other docks.
 */

import {
	registerDock,
	requestWorkspaceSave,
	getActiveWorkspaceProjectId
} from '$frontend/stores/ui/project-workspace.svelte';
import { getSessionsForProject } from '$frontend/stores/core/sessions.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

export interface ChatScrollEntry {
	atBottom: boolean;
	anchorMessageId: string | null;
	anchorOffset: number;
}

/** sessionId -> reading position. Spans every project; sliced per project on save. */
const chatScrollBySession = new Map<string, ChatScrollEntry>();

/** The chat dock's per-project slice: sessionId -> reading position. */
type ChatSlice = Record<string, ChatScrollEntry>;

/** Read a session's saved reading position (null when none). */
export function getChatScroll(sessionId: string): ChatScrollEntry | undefined {
	return chatScrollBySession.get(sessionId);
}

/**
 * Remember a session's reading position and queue a debounced server save of the
 * active project's chat slice so it survives a full refresh.
 */
export function setChatScroll(sessionId: string, entry: ChatScrollEntry): void {
	chatScrollBySession.set(sessionId, entry);
	requestWorkspaceSave();
}

registerDock({
	id: 'chat',
	snapshot() {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return undefined;
		// Only persist the positions of THIS project's sessions so a project's blob
		// never carries another project's reading positions.
		const slice: ChatSlice = {};
		for (const session of getSessionsForProject(projectId)) {
			const entry = chatScrollBySession.get(session.id);
			if (entry) slice[session.id] = entry;
		}
		return Object.keys(slice).length > 0 ? slice : undefined;
	},
	restore(slice) {
		if (slice && typeof slice === 'object') {
			for (const [sessionId, entry] of Object.entries(slice as ChatSlice)) {
				chatScrollBySession.set(sessionId, entry);
			}
		}
	}
	// No clear(): entries are keyed by (project-specific) session id, so the
	// previous project's positions can never apply to the new project's sessions.
});

registerProjectCleanup((projectId) => {
	for (const session of getSessionsForProject(projectId)) {
		chatScrollBySession.delete(session.id);
	}
});
