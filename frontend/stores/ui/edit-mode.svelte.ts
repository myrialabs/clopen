/**
 * Edit Mode State Store
 *
 * Edit mode belongs to the user who started it. The server keeps it per user
 * and per chat session, so it survives a refresh or a switch away and back;
 * collaborators are only told that someone is editing (`editors`) — they never
 * enter, cancel or submit another person's edit.
 *
 * What an edit rewinds to is NOT stored here: the server resolves it from the
 * edited message when the edit is submitted (see `chat:edit-target`).
 */

import ws from '$frontend/utils/ws';
import { userStore } from '$frontend/stores/features/user.svelte';
import { sessionState } from '$frontend/stores/core/sessions.svelte';

export interface EditAttachment {
	type: string;
	data: string; // base64
	mediaType: string;
	fileName: string;
}

export interface Editor {
	userId: string;
	userName: string;
	messageId: string;
}

interface EditModeState {
	isEditing: boolean;
	messageId: string | null;
	messageText: string;
	messageTimestamp: string | null;
	attachments: EditAttachment[];
	/** Other users editing a message in the chat session on screen. */
	editors: Editor[];
}

// Create reactive state
const state = $state<EditModeState>({
	isEditing: false,
	messageId: null,
	messageText: '',
	messageTimestamp: null,
	attachments: [],
	editors: []
});

function announce(messageId: string | null, messageTimestamp: string | null) {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId) return;

	ws.emit('chat:edit-mode', {
		chatSessionId,
		messageId,
		messageTimestamp,
		userName: userStore.currentUser?.name || ''
	});
}

function clearOwnEdit() {
	state.isEditing = false;
	state.messageId = null;
	state.messageText = '';
	state.messageTimestamp = null;
	state.attachments = [];
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Enter edit mode for a message
 */
export function startEdit(
	messageId: string,
	messageText: string,
	messageTimestamp: string,
	attachments: EditAttachment[] = []
) {
	state.isEditing = true;
	state.messageId = messageId;
	state.messageText = messageText;
	state.messageTimestamp = messageTimestamp;
	state.attachments = attachments;

	announce(messageId, messageTimestamp);
}

/**
 * Cancel edit mode
 */
export function cancelEdit() {
	const wasEditing = state.isEditing;
	clearOwnEdit();
	if (wasEditing) announce(null, null);
}

/**
 * Apply what the server restored for the session now on screen. The text and
 * attachments come back through the draft, so only the edit point is set here.
 */
export function applyRestoredEditMode(
	edit: { messageId: string; messageTimestamp: string | null } | null,
	editors: Editor[]
) {
	clearOwnEdit();
	if (edit) {
		state.isEditing = true;
		state.messageId = edit.messageId;
		state.messageTimestamp = edit.messageTimestamp;
	}
	state.editors = editors;
}

/**
 * Forget the previous session's edit state without telling the server — it
 * keeps it for when the user comes back. Called on every session switch.
 */
export function resetEditModeQuietly() {
	clearOwnEdit();
	state.editors = [];
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

// ============================================================================
// COLLABORATIVE LISTENER
// ============================================================================

/**
 * Track who else is editing in the session on screen.
 * Call once during app initialization.
 */
export function setupEditModeListener() {
	ws.on('chat:edit-presence', (data) => {
		if (data.chatSessionId !== sessionState.currentSession?.id) return;
		// Our own edit (from another tab or device) is restored with the session,
		// never pushed into this tab mid-typing.
		if (data.userId === userStore.currentUser?.id) return;

		const others = state.editors.filter((editor) => editor.userId !== data.userId);
		state.editors = data.messageId
			? [...others, { userId: data.userId, userName: data.userName, messageId: data.messageId }]
			: others;
	});
}

// Export reactive state
export const editModeState = state;
