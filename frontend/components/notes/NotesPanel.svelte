<script lang="ts">
	import { onMount } from 'svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { notesState, loadNotes, selectNote, clearNotes, createNote } from '$frontend/stores/features/notes.svelte';
	import NotesList from './NotesList.svelte';
	import NoteEditor from './NoteEditor.svelte';
	import { debug } from '$shared/utils/logger';

	let lastProjectId: string | null = null;

	$effect(() => {
		const pid = projectState.currentProject?.id ?? null;
		if (pid !== lastProjectId) {
			lastProjectId = pid;
			if (pid) {
				void loadNotes(pid);
			} else {
				clearNotes();
			}
		}
	});

	onMount(() => {
		const pid = projectState.currentProject?.id;
		if (pid) void loadNotes(pid);
	});

	async function handleCreate(): Promise<void> {
		const pid = projectState.currentProject?.id;
		if (!pid) return;
		try {
			const note = await createNote(pid, 'Untitled', '');
			if (note) debug.log('notes', 'Created note', note.id);
		} catch (error) {
			debug.error('notes', 'Create failed', error);
		}
	}

	function handleSelect(id: string): void {
		selectNote(id);
	}

	async function handleDelete(id: string): Promise<void> {
		const { deleteNote } = await import('$frontend/stores/features/notes.svelte');
		if (!confirm('Delete this note?')) return;
		await deleteNote(id);
	}
</script>

<div class="flex h-full w-full overflow-hidden bg-transparent">
	<div class="w-[320px] shrink-0 border-r border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col bg-white dark:bg-slate-900">
		<NotesList
			notes={notesState.notes}
			selectedId={notesState.currentNoteId}
			isLoading={notesState.isLoading}
			onSelect={handleSelect}
			onDelete={handleDelete}
			onCreate={handleCreate}
		/>
	</div>
	<div class="flex-1 min-w-0 overflow-hidden">
		<NoteEditor />
	</div>
</div>
