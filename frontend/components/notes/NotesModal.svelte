<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import NotesSidebar from './NotesSidebar.svelte';
	import NoteEditor from './NoteEditor.svelte';
	import NoteDeleteDialog from './NoteDeleteDialog.svelte';
	import { flushNoteSave } from '$frontend/stores/features/notes.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	const isMobile = $derived(windowWidth < 768);

	let pendingDeleteId = $state<string | null>(null);

	function handleResize(): void {
		windowWidth = window.innerWidth;
		if (!isMobile) isMobileMenuOpen = false;
	}

	// Closing mid-debounce would drop the last few seconds of typing, which is
	// the one thing removing the Save button must not cost.
	function handleClose(): void {
		void flushNoteSave();
		onClose();
	}
</script>

<svelte:window onresize={handleResize} />

<Modal
	bind:isOpen
	onClose={handleClose}
	bare
	mobileFullscreen
	ariaLabelledBy="notes-title"
	className="flex flex-col w-full max-w-5xl h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		{#if isMobile}
			<header class="flex items-center justify-between py-3 px-4 shrink-0 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800">
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
					onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
					aria-label="Toggle note list"
				>
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2 id="notes-title" class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0">
					Notes
				</h2>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
					onclick={handleClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}

		<div class="flex flex-1 min-h-0 relative">
			<aside
				class="flex flex-col w-72 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-30 w-80 shadow-[4px_0_20px_rgba(0,0,0,0.15)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				<!-- The title bar lives inside the sidebar, the way DB Client does it:
				     a full-width header would cost the editor a row of height and
				     leave most of that row empty. -->
				{#if !isMobile}
					<header class="flex items-center justify-between gap-2 py-1.5 pl-4 pr-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
						<div class="flex items-center gap-2 min-w-0">
							<Icon name="lucide:sticky-note" class="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
							<span id="notes-title" class="text-md font-bold text-slate-900 dark:text-slate-100">Notes</span>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-9 h-9 shrink-0 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
							onclick={handleClose}
							aria-label="Close"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}

				<NotesSidebar
					onDeleteNote={(id) => {
						pendingDeleteId = id;
						if (isMobile) isMobileMenuOpen = false;
					}}
				/>
			</aside>

			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[25] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<!-- NoteEditor brings its own padding and content card, so this is a
			     plain surface rather than a second frame around the first. -->
			<main class="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950">
				<NoteEditor />
			</main>
		</div>
	{/snippet}
</Modal>

<NoteDeleteDialog bind:noteId={pendingDeleteId} />
