<script lang="ts">
	/**
	 * The notes sidebar: scope switch, collections, and the notes inside them.
	 *
	 * Shaped after the DB Client connection list — one compact header row that
	 * turns into a search box once there is enough to search, and a `+` beside
	 * it rather than a button floating on a row of its own.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import {
		notesState,
		setScope,
		selectNote,
		createNote,
		createCollection,
		renameCollection,
		deleteCollection,
		toggleCollection
	} from '$frontend/stores/features/notes.svelte';
	import type { NoteCollection, NoteWithImages } from '$shared/types/database/schema';

	interface Props {
		/** Requests deletion of a note; the owner renders the confirmation. */
		onDeleteNote: (id: string) => void;
	}

	const { onDeleteNote }: Props = $props();

	// One size for every row action, so a collection's controls and a note's sit
	// on the same visual grid instead of one looking like a smaller class of thing.
	const ROW_ACTION =
		'flex items-center justify-center w-6 h-6 shrink-0 rounded-md text-slate-400 transition-colors';
	const ROW_ICON = 'w-3.5 h-3.5';

	const query = $derived(notesState.search.trim().toLowerCase());

	function plainText(note: NoteWithImages): string {
		const host = document.createElement('div');
		host.innerHTML = note.content;
		return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
	}

	function displayTitle(note: NoteWithImages): string {
		return note.title?.trim() || 'Untitled';
	}

	/**
	 * First line of the note as plain text.
	 *
	 * Content is stored as HTML, so tags are stripped and entities decoded —
	 * without the decode a note reading `A & B` previews as `A &amp; B`.
	 */
	function snippet(note: NoteWithImages): string {
		const text = plainText(note);
		if (text) return text.slice(0, 80);
		return note.images.length > 0
			? `${note.images.length} ${note.images.length === 1 ? 'image' : 'images'}`
			: 'Empty note';
	}

	function notesIn(collection: NoteCollection): NoteWithImages[] {
		return notesState.notes.filter((note) => {
			if (note.collection_id !== collection.id) return false;
			if (!query) return true;
			return (
				displayTitle(note).toLowerCase().includes(query) ||
				plainText(note).toLowerCase().includes(query)
			);
		});
	}

	// While searching, a collection with no match is noise rather than structure.
	const visibleCollections = $derived(
		notesState.collections.filter((c) => !query || notesIn(c).length > 0)
	);

	const totalNotes = $derived(notesState.notes.length);
	// Only the project scope needs one; global notes exist without any project.
	const needsProject = $derived(notesState.scope === 'project' && !projectState.currentProject);

	let newCollectionOpen = $state(false);
	let newCollectionName = $state('');
	let renameTarget = $state<NoteCollection | null>(null);
	let renameName = $state('');
	let deleteTarget = $state<NoteCollection | null>(null);

	const deleteMessage = $derived(
		deleteTarget
			? `"${deleteTarget.name}" and the ${notesState.notes.filter((n) => n.collection_id === deleteTarget?.id).length} note(s) inside it will be deleted, along with every attached image. This cannot be undone.`
			: ''
	);

	async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
		try {
			await action();
		} catch (error) {
			debug.error('notes', `${failure}:`, error);
			showError(failure, error instanceof Error ? error.message : String(error));
		}
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Scope switch. Global collections are visible to every signed-in user on
	     this instance, which the label has to say out loud. -->
	<div class="flex items-center gap-1 p-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
		<div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/60 w-full">
			<button
				type="button"
				onclick={() => run(() => setScope('project'), 'Failed to load notes')}
				class="flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-xs font-medium rounded-md transition-colors {notesState.scope ===
				'project'
					? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			>
				<Icon name="lucide:folder-git-2" class="w-3.5 h-3.5" />
				This project
			</button>
			<button
				type="button"
				onclick={() => run(() => setScope('global'), 'Failed to load notes')}
				title="Visible to everyone signed in to this Clopen instance"
				class="flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-xs font-medium rounded-md transition-colors {notesState.scope ===
				'global'
					? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			>
				<Icon name="lucide:globe" class="w-3.5 h-3.5" />
				Global
			</button>
		</div>
	</div>

	<!-- Unified header: search once there is something to search. Adding a note
	     belongs to a collection row, so the only thing here is adding a
	     collection. -->
	<div class="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
		{#if totalNotes > 0}
			<div class="flex-1 flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md min-w-0">
				<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
				<input
					type="text"
					bind:value={notesState.search}
					placeholder="Search notes…"
					class="py-1 flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
				/>
			</div>
		{:else}
			<span class="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
				Notes
			</span>
		{/if}
		<button
			type="button"
			class="{ROW_ACTION} hover:text-violet-600 hover:bg-violet-500/10"
			onclick={() => {
				newCollectionName = '';
				newCollectionOpen = true;
			}}
			aria-label="New collection"
			title="New collection"
		>
			<Icon name="lucide:folder-plus" class={ROW_ICON} />
		</button>
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
		{#if notesState.isLoading && notesState.collections.length === 0}
			<div class="flex items-center justify-center py-10">
				<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{:else if needsProject}
			<div class="flex flex-col items-center gap-2 py-8 px-3 text-center text-slate-500 dark:text-slate-400">
				<Icon name="lucide:folder-git-2" class="w-8 h-8 opacity-40" />
				<span class="text-xs">Open a project to keep notes in it</span>
			</div>
		{:else if visibleCollections.length === 0}
			<div class="flex flex-col items-center gap-2 py-8 px-3 text-center text-slate-500 dark:text-slate-400">
				<Icon name="lucide:sticky-note" class="w-8 h-8 opacity-40" />
				<span class="text-xs">{query ? 'No notes match that search' : 'No notes yet'}</span>
				{#if !query}
					<button
						type="button"
						class="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 underline"
						onclick={() => run(() => createNote(), 'Failed to create note')}
					>
						Write your first note
					</button>
				{/if}
			</div>
		{:else}
			{#each visibleCollections as collection (collection.id)}
				{@const notes = notesIn(collection)}
				{@const isCollapsed = notesState.collapsed[collection.id] && !query}
				<div class="flex flex-col">
					<div class="group/collection flex items-center gap-0.5 pr-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60">
						<button
							type="button"
							onclick={() => toggleCollection(collection.id)}
							class="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1.5 text-left"
						>
							<Icon
								name={isCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
								class="w-3.5 h-3.5 shrink-0 text-slate-400"
							/>
							<span class="flex-1 min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
								{collection.name}
							</span>
							<span class="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">{notes.length}</span>
						</button>
						<!-- Adding lives on the collection that will receive the note,
						     so there is no separate "which collection?" step. -->
						<button
							type="button"
							onclick={() => run(() => createNote(collection.id), 'Failed to create note')}
							class="{ROW_ACTION} hover:text-violet-600 hover:bg-violet-500/10"
							aria-label="New note in {collection.name}"
							title="New note"
						>
							<Icon name="lucide:plus" class={ROW_ICON} />
						</button>
						<button
							type="button"
							onclick={() => {
								renameTarget = collection;
								renameName = collection.name;
							}}
							class="{ROW_ACTION} hover:text-violet-600 hover:bg-violet-500/10"
							aria-label="Rename {collection.name}"
							title="Rename collection"
						>
							<Icon name="lucide:pencil" class={ROW_ICON} />
						</button>
						<button
							type="button"
							onclick={() => (deleteTarget = collection)}
							class="{ROW_ACTION} hover:text-red-600 hover:bg-red-500/10"
							aria-label="Delete {collection.name}"
							title="Delete collection"
						>
							<Icon name="lucide:trash-2" class={ROW_ICON} />
						</button>
					</div>

					{#if !isCollapsed}
						{#each notes as note (note.id)}
							<div
								class="relative rounded-lg transition-colors {notesState.currentNoteId === note.id
									? 'bg-violet-500/10'
									: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
							>
								<button type="button" onclick={() => selectNote(note.id)} class="w-full text-left pl-3 pr-9 py-2">
									<div
										class="text-sm font-medium truncate {notesState.currentNoteId === note.id
											? 'text-violet-700 dark:text-violet-300'
											: 'text-slate-800 dark:text-slate-100'}"
									>
										{displayTitle(note)}
									</div>
									<!-- No timestamp here: a second right-aligned element under a
									     right-aligned delete button read as two ragged columns. The
									     editor header carries it for the note being read. -->
									<div class="text-xs text-slate-500 dark:text-slate-400 truncate">{snippet(note)}</div>
								</button>
								<!-- Centred across both lines, and always visible: a destructive
								     action hidden behind hover cannot be reached by touch. -->
								<button
									type="button"
									onclick={() => onDeleteNote(note.id)}
									title="Delete note"
									aria-label="Delete {displayTitle(note)}"
									class="absolute right-2 top-1/2 -translate-y-1/2 {ROW_ACTION} hover:text-red-600 hover:bg-red-500/10"
								>
									<Icon name="lucide:trash-2" class={ROW_ICON} />
								</button>
							</div>
						{:else}
							<div class="pl-8 py-1.5 text-xs text-slate-400 dark:text-slate-500">No notes here</div>
						{/each}
					{/if}
				</div>
			{/each}
		{/if}
	</div>

</div>

<Dialog
	bind:isOpen={newCollectionOpen}
	onClose={() => (newCollectionOpen = false)}
	title="New collection"
	message={notesState.scope === 'global'
		? 'A global collection is visible to everyone signed in to this instance.'
		: 'Groups notes inside this project.'}
	bind:inputValue={newCollectionName}
	inputPlaceholder="Collection name"
	confirmText="Create"
	onConfirm={(value) => {
		const name = (value ?? '').trim();
		if (name) void run(() => createCollection(name), 'Failed to create collection');
	}}
/>

<Dialog
	isOpen={renameTarget !== null}
	onClose={() => (renameTarget = null)}
	title="Rename collection"
	bind:inputValue={renameName}
	inputPlaceholder="Collection name"
	confirmText="Rename"
	onConfirm={(value) => {
		const target = renameTarget;
		const name = (value ?? '').trim();
		renameTarget = null;
		if (target && name) void run(() => renameCollection(target.id, name), 'Failed to rename collection');
	}}
/>

<Dialog
	isOpen={deleteTarget !== null}
	onClose={() => (deleteTarget = null)}
	title="Delete collection"
	type="warning"
	message={deleteMessage}
	confirmText="Delete"
	onConfirm={() => {
		const target = deleteTarget;
		deleteTarget = null;
		if (target) void run(() => deleteCollection(target.id), 'Failed to delete collection');
	}}
/>
