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

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Data Management</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Manage your application data
	</p>

	<div class="flex flex-col gap-4">
		<!-- Danger Zone -->
		<div class="mt-2">
			<div class="flex items-center gap-2 mb-3 text-xs font-medium text-red-600 dark:text-red-400">
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
				<span>Danger Zone</span>
			</div>
			<div
				class="flex items-center justify-between gap-4 p-4 bg-red-500/5 dark:bg-red-500/5 border border-red-500/20 dark:border-red-500/20 rounded-lg max-sm:flex-col max-sm:items-stretch"
			>
				<div class="flex-1">
					<div class="text-sm font-medium text-slate-900 dark:text-slate-100 mb-1">
						Clear All Data
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
						Permanently delete all projects, conversations, and settings. This cannot be undone.
					</div>
				</div>
				<button
					type="button"
					class="flex items-center justify-center gap-2 py-2 px-4 bg-red-500/10 border border-red-500/25 rounded-lg text-red-600 dark:text-red-400 text-sm font-medium cursor-pointer transition-all duration-150 whitespace-nowrap hover:bg-red-500/15 hover:border-red-500/35 disabled:opacity-60 disabled:cursor-not-allowed"
					onclick={() => {
						clearTyped = '';
						clearDialogOpen = true;
					}}
					disabled={isClearing}
				>
					{#if isClearing}
						<div
							class="w-3.5 h-3.5 border-2 border-red-600/30 dark:border-red-400/30 border-t-red-600 dark:border-t-red-400 rounded-full animate-spin"
						></div>
						<span>Clearing...</span>
					{:else}
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						<span>Clear All Data</span>
					{/if}
				</button>
			</div>
		</div>
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
