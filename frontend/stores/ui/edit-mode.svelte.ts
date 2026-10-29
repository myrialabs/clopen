/**
 * Edit Mode State Store
 *
 * The server keeps edit mode per chat session, so it survives a refresh or a
 * switch away and back. It is restored with the session rather than pushed
 * into a tab mid-typing, so another device never edits under this one's feet.
 *
 * What an edit rewinds to is NOT stored here: the server resolves it from the
 * edited message when the edit is submitted (see `chat:edit-target`).
 */

import ws from '$frontend/utils/ws';
import { sessionState } from '$frontend/stores/core/sessions.svelte';
import { appState } from '$frontend/stores/core/app.svelte';

export interface EditAttachment {
	type: string;
	data: string; // base64
	mediaType: string;
	fileName: string;
}

interface EditModeState {
	isEditing: boolean;
	/** The session the edit belongs to — not necessarily the one on screen. */
	chatSessionId: string | null;
	messageId: string | null;
	messageText: string;
	messageTimestamp: string | null;
	attachments: EditAttachment[];
}

// Create reactive state
const state = $state<EditModeState>({
	isEditing: false,
	chatSessionId: null,
	messageId: null,
	messageText: '',
	messageTimestamp: null,
	attachments: []
});

/**
 * Bumped by every change made here, so an answer from the server that was
 * asked for before the change can tell it is out of date.
 */
let revision = 0;

function announce(chatSessionId: string, messageId: string | null, messageTimestamp: string | null) {
	ws.emit('chat:edit-mode', {
		chatSessionId,
		messageId,
		messageTimestamp
	});
}

function clearEdit() {
	state.isEditing = false;
	state.chatSessionId = null;
	state.messageId = null;
	state.messageText = '';
	state.messageTimestamp = null;
	state.attachments = [];
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Enter edit mode for a message of the session on screen. Refused while a turn
 * runs: the edit would rewind a branch that turn is still writing to.
 */
export function startEdit(
	messageId: string,
	messageText: string,
	messageTimestamp: string,
	attachments: EditAttachment[] = []
): boolean {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId || appState.isLoading) return false;

	revision++;
	state.isEditing = true;
	state.chatSessionId = chatSessionId;
	state.messageId = messageId;
	state.messageText = messageText;
	state.messageTimestamp = messageTimestamp;
	state.attachments = attachments;

	announce(chatSessionId, messageId, messageTimestamp);
	return true;
}

/**
 * Cancel edit mode
 */
export function cancelEdit() {
	const chatSessionId = state.isEditing ? state.chatSessionId : null;
	revision++;
	clearEdit();
	if (chatSessionId) announce(chatSessionId, null, null);
}

/**
 * The edit of a session was submitted. Its session is told even when the user
 * has switched away meanwhile — the switch only cleared what is on screen,
 * and a session never told would bring the finished edit back on its next
 * load.
 */
export function finishEdit(chatSessionId: string) {
	revision++;
	if (state.chatSessionId === chatSessionId) clearEdit();
	announce(chatSessionId, null, null);
}

/**
 * Apply what the server restored for the session now on screen. The text and
 * attachments come back through the draft, so only the edit point is set here.
 */
export function applyRestoredEditMode(
	chatSessionId: string,
	edit: { messageId: string; messageTimestamp: string | null } | null
) {
	clearEdit();
	if (edit) {
		state.isEditing = true;
		state.chatSessionId = chatSessionId;
		state.messageId = edit.messageId;
		state.messageTimestamp = edit.messageTimestamp;
	}
}

/**
 * Forget the previous session's edit state without telling the server — it
 * keeps it for when the session comes back on screen. Called on every session
 * switch.
 */
export function resetEditModeQuietly() {
	revision++;
	clearEdit();
}

/** Current change counter; see `revision`. */
export function getEditRevision(): number {
	return revision;
}

/**
 * Check if a message is after the edit point
 */
export function isMessageAfterEditPoint(messageTimestamp: string): boolean {
	if (!state.isEditing || !state.messageTimestamp) {
		return false;
	}
	return messageTimestamp > state.messageTimestamp;
}

/**
 * Check if a message is the one being edited
 */
export function isMessageBeingEdited(messageId: string | undefined): boolean {
	if (!state.isEditing || !state.messageId || !messageId) {
		return false;
	}
	return messageId === state.messageId;
}

/**
 * Check if a message should be dimmed (not the one being edited)
 */
export function shouldDimMessage(messageId: string | undefined): boolean {
	if (!state.isEditing) {
		return false;
	}
	return !isMessageBeingEdited(messageId);
}

// Export reactive state
export const editModeState = state;
