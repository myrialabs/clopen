<script lang="ts">
	/**
	 * "Needs you" from anywhere in Clopen: only what is waiting on the owner —
	 * questions, approvals, a service to connect, a key to enter. Updates go to
	 * where the owner is (Telegram, Clopen's screen), not here.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import NeedsYouCard from './NeedsYouCard.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { assistantView, closeNeedsYou } from '$frontend/stores/ui/assistant-view.svelte';

	const isOpen = $derived(assistantView.needsYouOpen);

	$effect(() => {
		if (isOpen) void assistantStore.loadInbox('all');
	});
</script>

<Modal
	{isOpen}
	onClose={closeNeedsYou}
	bare
	mobileFullscreen
	ariaLabelledBy="needs-you-title"
	className="flex flex-col w-full max-w-xl max-h-[85dvh] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-2xl"
>
	{#snippet children()}
		<header class="flex items-center gap-3 py-3 px-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 shrink-0">
			<Icon name="lucide:bell" class="w-5 h-5 text-violet-500" />
			<h2 id="needs-you-title" class="flex-1 text-base font-semibold text-slate-900 dark:text-slate-100">Needs you</h2>
			<button type="button" class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10 border-none bg-transparent cursor-pointer" onclick={closeNeedsYou} aria-label="Close"><Icon name="lucide:x" class="w-5 h-5" /></button>
		</header>
		<div class="flex-1 overflow-y-auto p-4 space-y-2.5">
			{#each assistantStore.needsYou as item (item.id)}
				<NeedsYouCard {item} />
			{:else}
				<div class="flex flex-col items-center text-center gap-2 py-12">
					<Icon name="lucide:check-check" class="w-8 h-8 text-emerald-500" />
					<p class="text-sm font-medium text-slate-700 dark:text-slate-300">Nothing needs you</p>
				</div>
			{/each}
		</div>
	{/snippet}
</Modal>
