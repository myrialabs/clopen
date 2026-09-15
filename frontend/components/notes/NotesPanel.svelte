<script lang="ts">
	import NotesSidebar from './NotesSidebar.svelte';
	import NoteEditor from './NoteEditor.svelte';
	import NoteDeleteDialog from './NoteDeleteDialog.svelte';

	// Loading is the notes dock's job, not this component's: the workspace
	// coordinator clears the previous project's notes before the switch is
	// revealed and loads the new project's behind this panel's skeleton.
	// Fetching from an $effect here would race that and paint stale notes.

	let pendingDeleteId = $state<string | null>(null);
</script>

<div class="flex h-full w-full overflow-hidden bg-transparent">
	<div class="w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col bg-white dark:bg-slate-900">
		<NotesSidebar onDeleteNote={(id) => (pendingDeleteId = id)} />
	</div>
	<!-- NoteEditor supplies its own padding and content card in both hosts. -->
	<div class="flex-1 min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950">
		<NoteEditor />
	</div>
</div>

<NoteDeleteDialog bind:noteId={pendingDeleteId} />
