/**
 * Edit Mode State Store
 * Manages message editing state with collaborative sync
 * Server is single source of truth - no client storage
 */

import ws from '$frontend/lib/utils/ws';
import { userStore } from '$frontend/lib/stores/features/user.svelte';
import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
import { debug } from '$shared/utils/logger';

export interface EditAttachment {
	type: 'image' | 'document';
	data: string; // base64
	mediaType: string;
	fileName: string;
}

interface EditModeState {
	isEditing: boolean;
	messageId: string | null;
	messageText: string;
	messageTimestamp: string | null;
	attachments: EditAttachment[];
	parentMessageId: string | null;
}

// Create reactive state
const state = $state<EditModeState>({
	isEditing: false,
	messageId: null,
	messageText: '',
	messageTimestamp: null,
	attachments: [],
	parentMessageId: null
});

// ============================================================================
// BROADCAST
// ============================================================================

function broadcastEditMode(isEditing: boolean, messageId: string | null, messageTimestamp: string | null) {
	const currentUserId = userStore.currentUser?.id;
	const chatSessionId = sessionState.currentSession?.id;
	if (!currentUserId || !chatSessionId) return;

	ws.emit('chat:edit-mode', {
		senderId: currentUserId,
		chatSessionId,
		isEditing,
		messageId,
		messageTimestamp
	});
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
	attachments: EditAttachment[] = [],
	parentMessageId: string | null = null
) {
	state.isEditing = true;
	state.messageId = messageId;
	state.messageText = messageText;
	state.messageTimestamp = messageTimestamp;
	state.attachments = attachments;
	state.parentMessageId = parentMessageId;

	broadcastEditMode(true, messageId, messageTimestamp);
}

/**
 * Cancel edit mode
 */
export function cancelEdit() {
	state.isEditing = false;
	state.messageId = null;
	state.messageText = '';
	state.messageTimestamp = null;
	state.attachments = [];
	state.parentMessageId = null;

	broadcastEditMode(false, null, null);
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
// SERVER STATE MANAGEMENT
// ============================================================================

/**
 * Clear state without broadcasting (for project switching)
 */
function clearStateQuietly() {
	state.isEditing = false;
	state.messageId = null;
	state.messageText = '';
	state.messageTimestamp = null;
	state.attachments = [];
	state.parentMessageId = null;
}

/**
 * Fetch edit mode state from server for the current project.
 * Server is the single source of truth.
 */
export async function restoreEditMode() {
	try {
		const chatSessionId = sessionState.currentSession?.id || '';
		const serverState = await ws.http('chat:get-edit-mode', { chatSessionId });
		if (serverState && serverState.isEditing && serverState.messageId) {
			state.isEditing = true;
			state.messageId = serverState.messageId;
			state.messageText = '';
			state.messageTimestamp = serverState.messageTimestamp;
			state.attachments = [];
			state.parentMessageId = null;
		} else {
			clearStateQuietly();
		}
	} catch {
		clearStateQuietly();
	}
}

/**
 * Called when switching away from a project.
 * Clears in-memory state without broadcasting (server retains per-project state).
 */
export function onProjectLeave() {
	clearStateQuietly();
}

/**
 * Called when entering a new project.
 * Fetches edit mode state from server for the new project.
 * MUST be called AFTER ws.setProject() has completed.
 */
export async function onProjectEnter() {
	await restoreEditMode();
}

// ============================================================================
// COLLABORATIVE LISTENER
// ============================================================================

/**
 * Setup WebSocket listener for edit mode events from other users.
 * Call once during app initialization.
 */
export function setupEditModeListener() {
	ws.on('chat:edit-mode', (data: {
		senderId: string;
		isEditing: boolean;
		messageId: string | null;
		messageTimestamp: string | null;
	}) => {
		const currentUserId = userStore.currentUser?.id;
		if (!currentUserId || data.senderId === currentUserId) return;

		if (data.isEditing && data.messageId) {
			debug.log('chat', `User ${data.senderId} started editing message ${data.messageId}`);
			state.isEditing = true;
			state.messageId = data.messageId;
			state.messageText = '';
			state.messageTimestamp = data.messageTimestamp;
			state.attachments = [];
			state.parentMessageId = null;
		} else {
			debug.log('chat', `User ${data.senderId} cancelled edit mode`);
			clearStateQuietly();
		}
	});
}

// Export reactive state
export const editModeState = state;
