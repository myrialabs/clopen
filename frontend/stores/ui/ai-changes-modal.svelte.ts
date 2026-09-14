/**
 * AI Changes Modal Store
 *
 * The review surface for "what has this chat changed" is reachable from two
 * places that cannot see each other: the summary above the chat input, and the
 * violet marker on a file in Files or Git. Whether it is open, and which file it
 * should land on, lives here rather than inside either of them.
 *
 * Deliberately separate from the checkpoint timeline. That modal exists to
 * restore a checkpoint, and folding a review surface into it made one dialog
 * answer two unrelated questions.
 */

interface AiChangesModalState {
	isOpen: boolean;
	/** Absolute path to select on open, if the caller came from a file. */
	focusPath: string | null;
}

export const aiChangesModal = $state<AiChangesModalState>({
	isOpen: false,
	focusPath: null
});

/** Open the review surface, optionally landing on one file. */
export function openAiChanges(absolutePath: string | null = null): void {
	aiChangesModal.focusPath = absolutePath;
	aiChangesModal.isOpen = true;
}

export function closeAiChanges(): void {
	aiChangesModal.isOpen = false;
	aiChangesModal.focusPath = null;
}
