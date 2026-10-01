import { onDestroy, untrack } from 'svelte';
import { editModeState, applyRestoredEditMode } from '$frontend/stores/ui/edit-mode.svelte';
import { chatInputState, resetFocus } from '$frontend/stores/ui/chat-input.svelte';
import { setQueue } from '$frontend/stores/ui/message-queue.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { sessionState } from '$frontend/stores/core/sessions.svelte';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import { attachmentFromBase64, type FileAttachment } from './use-file-handling.svelte';

/**
 * Composable for the composer's persistence: the user's own draft per chat
 * session, restored together with their edit mode and the session's queue.
 *
 * Drafts are per user (see backend/ws/chat/composer.ts) and never pushed into
 * anyone's box live: the server only keeps them for the next time this user
 * opens the session, on any device.
 */

interface InputStateParams {
	getMessageText: () => string;
	setMessageText: (text: string) => void;
	getTextareaElement: () => HTMLTextAreaElement | undefined;
	adjustTextareaHeight: () => void;
	getAttachedFiles: () => FileAttachment[];
	replaceAttachments: (files: FileAttachment[]) => void;
}

/** Typing settles for this long before the draft is saved. */
const TEXT_SAVE_DELAY_MS = 400;

type SyncAttachment = ReturnType<typeof serializeAttachments>[number];

function serializeAttachments(files: FileAttachment[]) {
	return files
		.filter((f) => f.base64)
		.map((f) => ({
			id: f.id,
			fileName: f.file.name,
			type: f.type,
			mediaType: f.file.type,
			base64: f.base64!
		}));
}

// ============================================================================
// REVISIONS (shared by every composer instance in this tab)
// ============================================================================

// Every draft write is stamped with a revision, and the newest write of each
// part wins — on the server and when restoring. Writes and restores race:
// the composer remounts when a new chat gets its first message, and the new
// instance's restore could read the server before the clear that followed the
// send, putting the sent text back in the box. Ordering by revision makes the
// outcome independent of which message arrives first.
let lastRevision = 0;

function nextRevision(): number {
	lastRevision = Math.max(Date.now(), lastRevision + 1);
	return lastRevision;
}

/** What this tab last wrote per session, so a restore can't roll it back. */
const localWrites = new Map<
	string,
	{
		text?: { value: string; revision: number };
		attachments?: { value: SyncAttachment[]; revision: number };
	}
>();

function writeDraft(chatSessionId: string, revision: number, text?: string, attachments?: SyncAttachment[]) {
	const local = localWrites.get(chatSessionId) ?? {};
	if (text !== undefined) local.text = { value: text, revision };
	if (attachments !== undefined) local.attachments = { value: attachments, revision };
	localWrites.set(chatSessionId, local);
	ws.emit('chat:draft-save', { chatSessionId, revision, text, attachments });
}

export function useInputState(params: InputStateParams) {
	// The session whose draft is in the box. Saves go to it, so a save that
	// fires after a switch can't write one session's draft into another.
	let boundSessionId: string | null = null;
	// Nothing is saved until the bound session's draft has been restored —
	// otherwise the empty box of a fresh mount would overwrite the stored draft.
	let restored = false;
	// The user typed (or attached, or sent) after the restore was requested.
	// Their input wins over the response that is still on its way.
	let editedSinceRestore = false;
	let restoreGeneration = 0;
	let textSaveTimer: ReturnType<typeof setTimeout> | null = null;
	// Revision of the latest keystroke not yet saved; null = nothing to save.
	// Only real edits are written, so an instance being torn down or switched
	// away never re-saves text it merely holds.
	let unsavedTextRevision: number | null = null;

	function flushText() {
		if (textSaveTimer) {
			clearTimeout(textSaveTimer);
			textSaveTimer = null;
		}
		if (!restored || !boundSessionId || unsavedTextRevision === null) return;
		writeDraft(boundSessionId, unsavedTextRevision, params.getMessageText());
		unsavedTextRevision = null;
	}

	/** Save typed text (debounced). */
	function saveText() {
		editedSinceRestore = true;
		unsavedTextRevision = nextRevision();
		if (!restored || !boundSessionId) return;
		if (textSaveTimer) clearTimeout(textSaveTimer);
		textSaveTimer = setTimeout(flushText, TEXT_SAVE_DELAY_MS);
	}

	/** Save attachments — only when they change, never per keystroke. */
	function saveAttachments(files: FileAttachment[]) {
		editedSinceRestore = true;
		if (!restored || !boundSessionId) return;
		writeDraft(boundSessionId, nextRevision(), undefined, serializeAttachments(files));
	}

	/** Drop the draft now (message sent, edit cancelled). */
	function clearDraft() {
		if (textSaveTimer) {
			clearTimeout(textSaveTimer);
			textSaveTimer = null;
		}
		unsavedTextRevision = null;
		// An emptied box is an edit too: a restore still in flight must not
		// refill it.
		editedSinceRestore = true;
		if (!boundSessionId) return;
		writeDraft(boundSessionId, nextRevision(), '', []);
	}

	// ============================================================================
	// RESTORE ON SESSION SWITCH
	// ============================================================================

	async function restore(chatSessionId: string) {
		const generation = ++restoreGeneration;
		try {
			// Ensure WS context (projectId) is synced before fetching
			await ws.waitForContextSync();
			const state = await ws.http('chat:composer-state', { chatSessionId });
			if (generation !== restoreGeneration) return;

			applyRestoredEditMode(state.edit, state.editors);
			setQueue(chatSessionId, state.queue);

			const { draft } = state;
			lastRevision = Math.max(lastRevision, draft.textRevision, draft.attachmentsRevision);

			if (editedSinceRestore) {
				// Typed into the box before the draft arrived: keep it, and make it
				// the draft.
				restored = true;
				flushText();
				saveAttachments(params.getAttachedFiles());
				return;
			}

			// Per part, the newest write wins: the server's, or one this tab made
			// that the server hasn't applied yet.
			const local = localWrites.get(chatSessionId);
			const text =
				local?.text && local.text.revision > draft.textRevision ? local.text.value : draft.text;
			const attachments =
				local?.attachments && local.attachments.revision > draft.attachmentsRevision
					? local.attachments.value
					: draft.attachments;

			params.setMessageText(text);
			params.replaceAttachments(
				attachments
					.map((a) => attachmentFromBase64(a))
					.filter((a): a is FileAttachment => a !== null)
			);
			restored = true;
			setTimeout(() => params.adjustTextareaHeight(), 0);
		} catch (error) {
			debug.error('chat', 'Error restoring composer state:', error);
			if (generation === restoreGeneration) restored = true;
		}
	}

	$effect(() => {
		const projectId = projectState.currentProject?.id;
		const chatSessionId = sessionState.currentSession?.id ?? null;
		if (!projectId || chatSessionId === boundSessionId) return;

		untrack(() => {
			// Leaving a session: whatever was typed in it is saved to it first.
			flushText();

			boundSessionId = chatSessionId;
			restored = false;
			editedSinceRestore = false;
			unsavedTextRevision = null;
			params.setMessageText('');
			params.replaceAttachments([]);
			setTimeout(() => params.adjustTextareaHeight(), 0);

			if (chatSessionId) void restore(chatSessionId);
		});
	});

	// ============================================================================
	// EDIT MODE ATTACHMENTS RESTORATION
	// ============================================================================

	// Starting an edit loads the message's attachments into the box.
	$effect(() => {
		if (editModeState.isEditing && editModeState.attachments.length > 0) {
			const incoming = editModeState.attachments;
			untrack(() => {
				params.replaceAttachments(
					incoming
						.map((a) => attachmentFromBase64({ fileName: a.fileName, mediaType: a.mediaType, base64: a.data }))
						.filter((a): a is FileAttachment => a !== null)
				);
				editModeState.attachments = [];
				saveAttachments(params.getAttachedFiles());
			});
		}
	});

	// ============================================================================
	// EXTERNAL TEXT (setInputText from elsewhere in the app)
	// ============================================================================

	$effect(() => {
		const text = chatInputState.text;
		if (text) {
			untrack(() => {
				params.setMessageText(text);
				chatInputState.text = '';
				saveText();
			});

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
	});

	onDestroy(() => {
		// The box is going away (welcome ↔ chat swap, panel close): keep its text.
		flushText();
	});

	return {
		saveText,
		saveAttachments,
		clearDraft
	};
}
