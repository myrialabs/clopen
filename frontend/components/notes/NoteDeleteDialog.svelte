<script lang="ts">
	/**
	 * The confirmation before deleting a note.
	 *
	 * Lives in one place because the panel and the modal both need it to say the
	 * same thing, including that the note's images go with it.
	 */
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { notesState, deleteNote } from '$frontend/stores/features/notes.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		/** The note awaiting confirmation, cleared once the user decides. */
		noteId: string | null;
	}

	let { noteId = $bindable() }: Props = $props();

	const note = $derived(notesState.notes.find((n) => n.id === noteId) ?? null);
	const message = $derived(
		note
			? `"${note.title?.trim() || 'Untitled'}"${note.images.length > 0 ? ` and its ${note.images.length} image(s)` : ''} will be deleted. This cannot be undone.`
			: ''
	);

	async function run(): Promise<void> {
		const target = noteId;
		noteId = null;
		if (!target) return;
		try {
			await deleteNote(target);
		} catch (error) {
			debug.error('notes', 'Delete failed:', error);
			showError('Failed to delete note', error instanceof Error ? error.message : String(error));
		}
	}
</script>

<Dialog
	isOpen={noteId !== null}
	onClose={() => (noteId = null)}
	title="Delete note"
	type="warning"
	{message}
	confirmText="Delete"
	onConfirm={run}
/>
