import { appState } from '$frontend/lib/stores/core/app.svelte';
import { sessionState, loadMessagesForSession } from '$frontend/lib/stores/core/sessions.svelte';
import { chatService } from '$frontend/lib/services/chat/chat.service';
import { snapshotService } from '$frontend/lib/services/snapshot/snapshot.service';
import { soundNotification } from '$frontend/lib/services/notification';
import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
import { editModeState, cancelEdit } from '$frontend/lib/stores/ui/edit-mode.svelte';
import { clearInput, setSkipNextRestore } from '$frontend/lib/stores/ui/chat-input.svelte';
import { debug } from '$shared/utils/logger';
import type { FileAttachment } from './use-file-handling.svelte';

interface ChatActionsParams {
	messageText: string;
	attachedFiles: FileAttachment[];
	clearAllAttachments: () => void;
	adjustTextareaHeight: () => void;
	focusTextarea: () => void;
	startLoadingAnimation: () => void;
	stopLoadingAnimation: () => void;
	clearDraft: () => void;
}

export function useChatActions(params: ChatActionsParams) {
	let isInputComposing = $state(false);

	// Handle cancel edit
	function handleCancelEdit() {
		cancelEdit();
		clearInput();
		params.messageText = ''; // This won't work directly, need to pass setter
		params.clearAllAttachments();
		params.adjustTextareaHeight();
	}

	// Handle send message with SDK streaming
	async function sendMessage(messageText: string, setMessageText: (value: string) => void) {
		if ((!messageText.trim() && params.attachedFiles.length === 0) || appState.isLoading) return;

		// Initialize sound notifications on first user interaction (browser policy requirement)
		soundNotification.initialize();

		const userMessage = messageText.trim();
		const files = [...params.attachedFiles]; // Copy current attachments

		// If in edit mode, restore to parent of edited message first
		if (editModeState.isEditing) {
			try {
				// Restore to parent of edited message (if exists)
				const restoreTargetId = editModeState.parentMessageId || editModeState.messageId;

				if (restoreTargetId && sessionState.currentSession?.id) {
					await snapshotService.restore(restoreTargetId, sessionState.currentSession.id);
				}

				// Reload messages from database to update UI
				if (sessionState.currentSession?.id) {
					await loadMessagesForSession(sessionState.currentSession.id);
				}

				// Exit edit mode
				cancelEdit();
			} catch (error) {
				debug.error('chat', 'Edit restore error:', error);
				addNotification({
					type: 'error',
					title: 'Edit Failed',
					message: error instanceof Error ? error.message : 'Unknown error',
					duration: 5000
				});
				return; // Don't send message if restore failed
			}
		}

		// Clear input and attachments
		// Set skip flag BEFORE clearing - prevents stale input restoration
		// when ChatInput is remounted during welcome→chat transition
		setSkipNextRestore(true);
		params.clearDraft();
		setMessageText('');
		params.clearAllAttachments();
		params.adjustTextareaHeight();

		// Focus back to textarea
		params.focusTextarea();

		// Start loading text rotation with typewriter effect
		params.startLoadingAnimation();

		// Send message via WebSocket with file attachments
		const attachedFiles = files
			.filter(f => f.base64)
			.map(f => ({
				type: f.type,
				data: f.base64!,
				mediaType: f.file.type,
				fileName: f.file.name
			}));

		await chatService.sendMessage(userMessage, {
			attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
			onStreamEnd: () => {
				params.stopLoadingAnimation();
			},
			onError: () => {
				params.stopLoadingAnimation();
			}
		});
	}

	// Cancel current request
	async function cancelRequest() {
		chatService.cancelRequest();
		params.stopLoadingAnimation();
	}

	// Handle key press
	function handleKeyPress(
		event: KeyboardEvent,
		messageText: string,
		setMessageText: (value: string) => void
	) {
		if (event.key === 'Enter' && !event.shiftKey && !isInputComposing) {
			event.preventDefault();
			sendMessage(messageText, setMessageText);
		}
	}

	// Handle composition events for international keyboards
	function handleCompositionStart() {
		isInputComposing = true;
	}

	function handleCompositionEnd() {
		isInputComposing = false;
	}

	return {
		get isInputComposing() {
			return isInputComposing;
		},
		handleCancelEdit,
		sendMessage,
		cancelRequest,
		handleKeyPress,
		handleCompositionStart,
		handleCompositionEnd
	};
}
