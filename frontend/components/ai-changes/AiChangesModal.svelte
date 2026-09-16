<script lang="ts">
	/**
	 * The review surface for everything this chat changed.
	 *
	 * Hosted at workspace level rather than inside the chat panel: it is opened
	 * from the summary row of the composer AND from the violet marker in Files
	 * and Git, and those panels can be on screen with the chat hidden.
	 *
	 * A bare shell, like Notes: the title and the totals live in the sidebar, so
	 * the diff gets the dialog's full height instead of paying a row for a header
	 * that is mostly empty space.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ChangesView from './ChangesView.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { aiChangesModal, closeAiChanges } from '$frontend/stores/ui/ai-changes-modal.svelte';

	const sessionId = $derived(sessionState.currentSession?.id);
</script>

<Modal
	isOpen={aiChangesModal.isOpen}
	onClose={closeAiChanges}
	bare
	mobileFullscreen
	ariaLabelledBy="ai-changes-title"
	className="flex flex-col w-full max-w-[min(85vw,1600px)] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<ChangesView
			{sessionId}
			focusPath={aiChangesModal.focusPath}
			onClose={closeAiChanges}
			onNavigateAway={closeAiChanges}
		/>
	{/snippet}
</Modal>
