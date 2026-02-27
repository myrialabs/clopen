import { onMount, onDestroy } from 'svelte';
import { editModeState } from '$frontend/lib/stores/ui/edit-mode.svelte';
import { chatInputState, resetFocus, shouldSkipRestore } from '$frontend/lib/stores/ui/chat-input.svelte';
import { projectState } from '$frontend/lib/stores/core/projects.svelte';
import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
import { userStore } from '$frontend/lib/stores/features/user.svelte';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';
import type { FileAttachment } from './use-file-handling.svelte';

/**
 * Composable for managing input state synchronization
 * Server-side only - no client storage. WebSocket is single source of truth.
 */

interface InputStateParams {
	setMessageText: (text: string) => void;
	getTextareaElement: () => HTMLTextAreaElement | undefined;
	adjustTextareaHeight: () => void;
	focusTextarea: () => void;
	setAttachedFiles: (files: FileAttachment[]) => void;
}

interface SyncAttachment {
	id: string;
	fileName: string;
	type: string;
	mediaType: string;
	base64: string;
}

export function useInputState(params: InputStateParams) {
	let initialized = false;
	let isReceivingSync = false;
	// Block all outgoing syncs until first server restore completes.
	// Prevents race condition where empty initial state overwrites server data.
	let hasRestoredOnce = false;

	// ============================================================================
	// SERVER STATE RESTORATION (replaces sessionStorage draft)
	// ============================================================================

	/**
	 * Restore input state from server.
	 * Server stores latest input per project (typed by any user).
	 */
	async function restoreFromServer() {
		// Skip restoration if a message was just sent (prevents stale input
		// restoration when ChatInput is remounted during welcome→chat transition)
		if (shouldSkipRestore()) {
			hasRestoredOnce = true;
			return;
		}

		try {
			// Ensure WS context (projectId) is synced before fetching
			await ws.waitForContextSync();

			const chatSessionId = sessionState.currentSession?.id || '';
			const serverState = await ws.http('chat:get-input-state', { chatSessionId });

			isReceivingSync = true;

			// Always apply server state (including empty) to fully replace current state
			params.setMessageText(serverState?.text || '');

			// Restore or clear attachments from server state
			if (serverState?.attachments && serverState.attachments.length > 0) {
				const restoredFiles = deserializeAttachments(serverState.attachments);
				params.setAttachedFiles(restoredFiles);
			} else {
				params.setAttachedFiles([]);
			}

			setTimeout(() => {
				params.adjustTextareaHeight();
				isReceivingSync = false;
				hasRestoredOnce = true;
			}, 50);
		} catch (error) {
			debug.error('chat', 'Error restoring input state from server:', error);
			isReceivingSync = false;
			hasRestoredOnce = true;
		}
	}

	/**
	 * Clear server input state for current project
	 */
	function clearServerInputState() {
		const currentUserId = userStore.currentUser?.id;
		const chatSessionId = sessionState.currentSession?.id;
		if (!currentUserId || !chatSessionId) return;

		ws.emit('chat:input-sync', {
			text: '',
			senderId: currentUserId,
			chatSessionId,
			attachments: []
		});
	}

	// Watch for project or session changes to restore input state from server
	let lastProjectId: string | undefined;
	let lastSessionId: string | undefined;
	$effect(() => {
		const projectId = projectState.currentProject?.id;
		const chatSessionId = sessionState.currentSession?.id;
		const key = `${projectId}:${chatSessionId}`;
		const lastKey = `${lastProjectId}:${lastSessionId}`;
		if (projectId && chatSessionId && key !== lastKey) {
			lastProjectId = projectId;
			lastSessionId = chatSessionId;
			// Block outgoing syncs until restoration completes for this session
			hasRestoredOnce = false;
			restoreFromServer();
		}
	});

	// ============================================================================
	// ATTACHMENT DESERIALIZATION (shared helper)
	// ============================================================================

	function deserializeAttachments(attachments: SyncAttachment[]): FileAttachment[] {
		const restoredFiles: FileAttachment[] = [];
		for (const att of attachments) {
			try {
				const byteString = atob(att.base64);
				const arrayBuffer = new ArrayBuffer(byteString.length);
				const uint8Array = new Uint8Array(arrayBuffer);
				for (let i = 0; i < byteString.length; i++) {
					uint8Array[i] = byteString.charCodeAt(i);
				}
				const blob = new Blob([uint8Array], { type: att.mediaType });
				const file = new File([blob], att.fileName, { type: att.mediaType });

				const attachment: FileAttachment = {
					id: att.id,
					file,
					type: att.type as 'image' | 'document',
					base64: att.base64
				};

				if (att.type === 'image') {
					attachment.previewUrl = URL.createObjectURL(blob);
				}

				restoredFiles.push(attachment);
			} catch (error) {
				debug.error('chat', 'Error deserializing attachment:', error);
			}
		}
		return restoredFiles;
	}

	// ============================================================================
	// EDIT MODE ATTACHMENTS RESTORATION
	// ============================================================================

	// Watch for edit mode attachments and restore them
	$effect(() => {
		if (editModeState.isEditing && editModeState.attachments.length > 0) {
			restoreEditModeAttachments();
		}
	});

	async function restoreEditModeAttachments() {
		const newAttachments: FileAttachment[] = [];

		for (const editAttachment of editModeState.attachments) {
			try {
				// Convert base64 to Blob
				const byteString = atob(editAttachment.data);
				const arrayBuffer = new ArrayBuffer(byteString.length);
				const uint8Array = new Uint8Array(arrayBuffer);
				for (let i = 0; i < byteString.length; i++) {
					uint8Array[i] = byteString.charCodeAt(i);
				}
				const blob = new Blob([uint8Array], { type: editAttachment.mediaType });

				// Create File from Blob
				const file = new File([blob], editAttachment.fileName, {
					type: editAttachment.mediaType
				});

				// Create attachment object
				const attachment: FileAttachment = {
					id: crypto.randomUUID(),
					file: file,
					type: editAttachment.type as 'image' | 'document',
					base64: editAttachment.data
				};

				// Create preview URL for images
				if (editAttachment.type === 'image') {
					attachment.previewUrl = URL.createObjectURL(blob);
				}

				newAttachments.push(attachment);
			} catch (error) {
				debug.error('chat', 'Error restoring attachment:', error);
			}
		}

		// Set restored attachments
		params.setAttachedFiles(newAttachments);
	}

	onMount(() => {
		initialized = true;
	});

	// ============================================================================
	// EXTERNAL TEXT SYNC
	// ============================================================================

	// Watch for external text changes from restore functionality
	$effect(() => {
		if (chatInputState.text) {
			syncExternalTextChange();
		}
	});

	function syncExternalTextChange() {
		// Set message text from external source
		params.setMessageText(chatInputState.text);

		// Clear the store text after using it
		chatInputState.text = '';

		// Adjust textarea height and focus after DOM update
		setTimeout(() => {
			params.adjustTextareaHeight();

			const textareaElement = params.getTextareaElement();
			if (textareaElement && chatInputState.shouldFocus) {
				textareaElement.focus();
				// Move cursor to end of text
				const textLength = textareaElement.value.length;
				textareaElement.selectionStart = textLength;
				textareaElement.selectionEnd = textLength;
			}

			resetFocus();
		}, 0);
	}

	// ============================================================================
	// Input sync
	// ============================================================================

	let unsubscribeInputSync: (() => void) | null = null;

	// Listen for input sync from other users
	unsubscribeInputSync = ws.on('chat:input-sync', (data: { text: string; senderId: string; attachments?: SyncAttachment[] }) => {
		const currentUserId = userStore.currentUser?.id;
		// Skip if this is our own input
		if (!currentUserId || data.senderId === currentUserId) return;

		isReceivingSync = true;
		params.setMessageText(data.text);

		// Restore attachments from sync data
		if (data.attachments !== undefined) {
			const restoredFiles = deserializeAttachments(data.attachments);
			params.setAttachedFiles(restoredFiles);
		}

		setTimeout(() => {
			params.adjustTextareaHeight();
			isReceivingSync = false;
		}, 0);
	});

	/**
	 * Emit input sync event to other users (realtime, no debounce)
	 * Server stores this as the latest input state for the project
	 */
	function emitInputSync(text: string, attachedFiles?: FileAttachment[]) {
		// Don't emit if we're receiving a sync from another user
		if (isReceivingSync) return;
		// Don't emit until server state has been restored at least once
		if (!hasRestoredOnce) return;

		// Sync to server and other users
		const currentUserId = userStore.currentUser?.id;
		const chatSessionId = sessionState.currentSession?.id;
		if (!currentUserId || !chatSessionId) return;

		// Serialize attachments for sync
		let attachments: SyncAttachment[] | undefined;
		if (attachedFiles && attachedFiles.length > 0) {
			attachments = attachedFiles
				.filter(f => f.base64) // Only sync files that have base64 data
				.map(f => ({
					id: f.id,
					fileName: f.file.name,
					type: f.type,
					mediaType: f.file.type,
					base64: f.base64!
				}));
		}

		ws.emit('chat:input-sync', {
			text,
			senderId: currentUserId,
			chatSessionId,
			attachments
		});
	}

	/**
	 * Emit attachment sync when files change
	 */
	function emitAttachmentSync(text: string, attachedFiles: FileAttachment[]) {
		if (isReceivingSync) return;
		if (!initialized) return; // Don't emit on initial mount
		// Don't emit until server state has been restored at least once
		if (!hasRestoredOnce) return;

		// Sync to server and other users
		const currentUserId = userStore.currentUser?.id;
		const chatSessionId = sessionState.currentSession?.id;
		if (!currentUserId || !chatSessionId) return;

		const attachments: SyncAttachment[] = attachedFiles
			.filter(f => f.base64)
			.map(f => ({
				id: f.id,
				fileName: f.file.name,
				type: f.type,
				mediaType: f.file.type,
				base64: f.base64!
			}));

		ws.emit('chat:input-sync', {
			text,
			senderId: currentUserId,
			chatSessionId,
			attachments
		});
	}

	onDestroy(() => {
		if (unsubscribeInputSync) {
			unsubscribeInputSync();
		}
	});

	return {
		restoreEditModeAttachments,
		syncExternalTextChange,
		emitInputSync,
		emitAttachmentSync,
		clearDraft: clearServerInputState
	};
}
