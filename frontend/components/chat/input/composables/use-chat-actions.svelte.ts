import { appState } from '$frontend/stores/core/app.svelte';
import { sessionState, loadMessagesForSession } from '$frontend/stores/core/sessions.svelte';
import { chatService } from '$frontend/services/chat/chat.service';
import { snapshotService } from '$frontend/services/snapshot/snapshot.service';
import type { RestoreConflict, ConflictResolution } from '$frontend/services/snapshot/snapshot.service';
import { soundNotification } from '$frontend/services/notification';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { editModeState, cancelEdit } from '$frontend/stores/ui/edit-mode.svelte';
import { clearInput } from '$frontend/stores/ui/chat-input.svelte';
import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { FileAttachment } from './use-file-handling.svelte';

interface ChatActionsParams {
	getAttachedFiles: () => FileAttachment[];
	isProcessingFiles: () => boolean;
	clearAllAttachments: () => void;
	setMessageText: (text: string) => void;
	adjustTextareaHeight: () => void;
	focusTextarea: () => void;
	clearDraft: () => void;
}

interface PendingEdit {
	chatSessionId: string;
	targetId: string;
	text: string;
	files: FileAttachment[];
}

function toWireAttachments(files: FileAttachment[]) {
	return files
		.filter((f) => f.base64)
		.map((f) => ({
			type: f.type,
			data: f.base64!,
			mediaType: f.file.type,
			fileName: f.file.name
		}));
}

/**
 * On a touch keyboard there is no Shift, so Enter has to mean "new line" or
 * multi-line messages can't be written at all; the Send button sends. With a
 * physical keyboard Enter sends and Shift+Enter breaks the line.
 */
function enterSends(): boolean {
	return !window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

export function useChatActions(params: ChatActionsParams) {
	// One submit at a time. An edit awaits a restore before it sends, and a
	// second Enter during that wait used to restore and send twice.
	let isSubmitting = $state(false);
	let isInputComposing = $state(false);
	// An edit held back until the user decides what happens to files another
	// session changed since.
	let pendingEdit = $state<PendingEdit | null>(null);
	let conflicts = $state<RestoreConflict[]>([]);

	function resetComposer() {
		params.clearDraft();
		params.setMessageText('');
		params.clearAllAttachments();
		params.adjustTextareaHeight();
		params.focusTextarea();
	}

	async function sendNow(text: string, files: FileAttachment[]) {
		// Initialize sound notifications on first user interaction (browser policy requirement)
		soundNotification.initialize();
		resetComposer();

		const attachedFiles = toWireAttachments(files);
		await chatService.sendMessage(text, {
			attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined
		});
	}

	function queue(text: string, files: FileAttachment[]) {
		const attachedFiles = toWireAttachments(files);
		if (chatService.queueMessage(text, attachedFiles.length > 0 ? attachedFiles : undefined)) {
			resetComposer();
		}
	}

	/** Rewind to before the edited message, then send the new version. */
	async function completeEdit(edit: PendingEdit, resolutions?: ConflictResolution) {
		await snapshotService.restore(edit.targetId, edit.chatSessionId, resolutions);
		// The draft belongs to the edit; it is spent now.
		params.clearDraft();
		await loadMessagesForSession(edit.chatSessionId);
		cancelEdit();
		if (sessionState.currentSession?.id !== edit.chatSessionId) return;
		await sendNow(edit.text, edit.files);
	}

	async function submitEdit(text: string, files: FileAttachment[]) {
		const chatSessionId = sessionState.currentSession?.id;
		const messageId = editModeState.messageId;
		if (!chatSessionId || !messageId) return;

		// The rewind point comes from the server, from the edited message itself.
		const { targetId } = await ws.http('chat:edit-target', { chatSessionId, messageId });
		const edit: PendingEdit = { chatSessionId, targetId, text, files };

		// Same safeguard as Undo: files another chat changed since are not
		// overwritten without asking.
		let found: RestoreConflict[] = [];
		try {
			const check = await snapshotService.checkConflicts(targetId, chatSessionId);
			if (check.hasConflicts) found = check.conflicts;
		} catch (error) {
			debug.warn('chat', 'Conflict check before edit failed; continuing without it:', error);
		}

		if (found.length > 0) {
			pendingEdit = edit;
			conflicts = found;
			return;
		}
		await completeEdit(edit);
	}

	function reportError(error: unknown) {
		debug.error('chat', 'Submit error:', error);
		addNotification({
			type: 'error',
			title: editModeState.isEditing ? 'Edit Failed' : 'Send Failed',
			message: error instanceof Error ? error.message : 'Unknown error',
			duration: 5000
		});
	}

	/**
	 * Send, queue or submit the edit — whichever the composer is in. Returns
	 * without doing anything when there's nothing to send or it can't be sent.
	 */
	async function submit(messageText: string) {
		if (isSubmitting) return;
		const text = messageText.trim();
		const files = [...params.getAttachedFiles()];
		if (!text && files.length === 0) return;
		// Attachments still being read would be left out of the message.
		if (params.isProcessingFiles()) return;
		// The turn is blocked on the question above; a message can't follow it.
		if (appState.isWaitingInput || appState.isCancelling) return;

		isSubmitting = true;
		try {
			if (editModeState.isEditing) {
				// Rewinding mid-turn would race the engine; the server refuses it too.
				if (appState.isLoading) return;
				await submitEdit(text, files);
			} else if (appState.isLoading) {
				queue(text, files);
			} else {
				await sendNow(text, files);
			}
		} catch (error) {
			reportError(error);
		} finally {
			isSubmitting = false;
		}
	}

	/** The user chose what to do with the conflicting files. */
	async function resolveConflicts(resolutions: ConflictResolution) {
		const edit = pendingEdit;
		pendingEdit = null;
		conflicts = [];
		if (!edit) return;
		isSubmitting = true;
		try {
			await completeEdit(edit, resolutions);
		} catch (error) {
			reportError(error);
		} finally {
			isSubmitting = false;
		}
	}

	/** The conflict dialog was closed: nothing is restored, the edit stays. */
	function dismissConflicts() {
		pendingEdit = null;
		conflicts = [];
	}

	function handleCancelEdit() {
		cancelEdit();
		clearInput();
		resetComposer();
	}

	function cancelRequest() {
		chatService.cancelRequest();
	}

	function handleKeyDown(event: KeyboardEvent, messageText: string) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		// keyCode 229: the keystroke belongs to an IME (Safari reports the
		// composition-ending Enter after compositionend).
		if (isInputComposing || event.isComposing || event.keyCode === 229) return;
		if (!enterSends()) return;
		event.preventDefault();
		void submit(messageText);
	}

	return {
		get isSubmitting() {
			return isSubmitting;
		},
		get conflicts() {
			return conflicts;
		},
		submit,
		resolveConflicts,
		dismissConflicts,
		handleCancelEdit,
		cancelRequest,
		handleKeyDown,
		handleCompositionStart: () => {
			isInputComposing = true;
		},
		handleCompositionEnd: () => {
			isInputComposing = false;
		}
	};
}
