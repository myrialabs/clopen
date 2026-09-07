<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import NotesList from './NotesList.svelte';
	import NoteEditor from './NoteEditor.svelte';
	import { notesState } from '$frontend/stores/features/notes.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { loadNotes, selectNote } from '$frontend/stores/features/notes.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	const isMobile = $derived(windowWidth < 768);

	function handleResize(): void {
		windowWidth = window.innerWidth;
		if (!isMobile) isMobileMenuOpen = false;
	}

	$effect(() => {
		if (isOpen && projectState.currentProject?.id) {
			void loadNotes(projectState.currentProject.id);
		}
	});

	function handleSelect(id: string): void {
		selectNote(id);
		if (isMobile) isMobileMenuOpen = false;
	}

	async function handleCreate(): Promise<void> {
		const pid = projectState.currentProject?.id;
		if (!pid) return;
		const { createNote } = await import('$frontend/stores/features/notes.svelte');
		try {
			const note = await createNote(pid, 'Untitled', '');
			if (note) debug.log('notes', 'Created note', note.id);
			if (isMobile) isMobileMenuOpen = false;
		} catch (e) {
			debug.error('notes', 'Create failed', e);
		}
	}

	async function handleDelete(id: string): Promise<void> {
		const { deleteNote } = await import('$frontend/stores/features/notes.svelte');
		if (!confirm('Delete this note?')) return;
		await deleteNote(id);
	}
</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="notes-title"
	className="flex flex-col w-full max-w-[90vw] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		{#if isMobile}
			<header class="flex items-center justify-between py-3 px-4 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800">
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
					aria-label="Toggle menu"
				>
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2 id="notes-title" class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0">Notes</h2>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={onClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}

		<div class="flex flex-1 min-h-0 relative">
			<aside
				class="flex flex-col w-72 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-30 w-80 bg-white dark:bg-slate-900 shadow-[4px_0_20px_rgba(0,0,0,0.15)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header class="flex items-center justify-between py-1.5 px-4 pl-6 border-b border-slate-200 dark:border-slate-800 shrink-0">
						<div class="flex items-center gap-2.5 text-md font-bold text-slate-900 dark:text-slate-100">
							<span>Notes</span>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							onclick={onClose}
							aria-label="Close"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}

				<div class="flex flex-col min-h-0 flex-1">
					<NotesList
						notes={notesState.notes}
						selectedId={notesState.currentNoteId}
						isLoading={notesState.isLoading}
						onSelect={handleSelect}
						onDelete={handleDelete}
						onCreate={handleCreate}
					/>
				</div>
			</aside>

			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[25] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<main class="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950">
				<div class="flex-1 min-h-0 p-3 flex flex-col">
					<div class="flex-1 min-h-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col shadow-sm">
						<NoteEditor />
					</div>
				</div>
			</main>
		</div>
	{/snippet}
</Modal>
