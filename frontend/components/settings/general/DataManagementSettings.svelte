<script lang="ts">
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';

	let isClearing = $state(false);
	let clearDialogOpen = $state(false);
	let clearTyped = $state('');

	async function clearData() {
		// Guard the handler too, not just the button. `Dialog` confirms on Enter,
		// and a disabled button is a UI state rather than a rule.
		if (clearTyped.trim() !== 'DELETE') return;
		clearDialogOpen = false;
		isClearing = true;
		try {
			const response = await ws.http('system:clear-data', {});

			if (response.cleared) {
				localStorage.clear();
				sessionStorage.clear();
				window.location.reload();
			}
		} catch (error) {
			debug.error('settings', 'Error clearing data:', error);
			isClearing = false;
			addNotification({
				type: 'error',
				title: 'Clear Data Error',
				message: 'Failed to clear all data',
				duration: 4000
			});
		}
	}
</script>

<!-- Settings → Storage → Clean up → Everything. Laid out as one more cleanup
     row (same card, icon, text and button as the others) so the last step reads
     as part of the same list; the dialog is what makes it serious. -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<div class="flex items-start gap-3 px-4 py-2.5">
		<div class="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 mt-0.5 bg-red-500/10 text-red-500">
			<Icon name="lucide:triangle-alert" class="w-4 h-4" />
		</div>
		<div class="flex-1 min-w-0">
			<span class="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Clear all data</span>
			<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
				Permanently deletes every project, conversation, memory and setting. Engines must be signed in again. This cannot be undone.
			</p>
		</div>
		<button
			type="button"
			class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 enabled:hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={() => {
				clearTyped = '';
				clearDialogOpen = true;
			}}
			disabled={isClearing}
		>
			{#if isClearing}
				<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
				Clearing…
			{:else}
				Delete everything
			{/if}
		</button>
	</div>
</div>

<!--
	Typed confirmation, matching "Delete all memory" in the Memory panel. This is
	the widest-reaching destructive action in the product — projects, sessions,
	settings and every engine credential, with no undo and no export beforehand —
	and it sat behind a single OK button while deleting only the memory graph
	asked you to type DELETE. The gesture should scale with what is at stake.
-->
<Dialog
	bind:isOpen={clearDialogOpen}
	bind:inputValue={clearTyped}
	onClose={() => (clearDialogOpen = false)}
	title="Clear all data"
	type="error"
	message={'Every project, conversation, memory and setting will be permanently deleted, and connected engines will need to be signed in again. There is no undo and no backup.\nType DELETE to confirm.'}
	inputPlaceholder="DELETE"
	confirmText="Delete everything"
	cancelText="Cancel"
	confirmDisabled={clearTyped.trim() !== 'DELETE'}
	onConfirm={() => void clearData()}
/>
