<script lang="ts">
	import Dialog from '../overlay/Dialog.svelte';
	import Icon from '../display/Icon.svelte';
	import ReleaseNotesList from './ReleaseNotesList.svelte';
	import { updateState, runUpdate, dismissWhatsNew } from '$frontend/stores/ui/update.svelte';

	function handleClose() {
		dismissWhatsNew();
	}

	function handleUpdateNow() {
		dismissWhatsNew();
		runUpdate();
	}
</script>

<Dialog
	bind:isOpen={updateState.showWhatsNewModal}
	onClose={handleClose}
	title="What's new in v{updateState.latestVersion}"
	type="info"
	showCancel={false}
	maxWidth="max-w-lg"
>
	<div class="flex items-center gap-3">
		<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-500/15 text-violet-500">
			<Icon name="lucide:sparkles" class="w-5 h-5" />
		</div>
		<h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
			v{updateState.latestVersion} is available
		</h2>
	</div>

	<div class="mt-4 max-h-[50vh] overflow-y-auto pr-1">
		{#if updateState.releaseNotesLoading}
			<div class="flex items-center gap-2 text-sm text-slate-500">
				<div class="w-4 h-4 border-2 border-slate-500/30 border-t-slate-500 rounded-full animate-spin"></div>
				Loading release notes...
			</div>
		{:else if updateState.releaseNotes}
			<ReleaseNotesList releases={updateState.releaseNotes} />
		{:else if updateState.releaseNotesError}
			<p class="text-sm text-red-600 dark:text-red-400">Could not load release notes. Check your connection.</p>
		{/if}
	</div>

	<div class="flex justify-end gap-3 pt-4 mt-2 border-t border-slate-200 dark:border-slate-700">
		<button
			type="button"
			onclick={handleClose}
			class="px-6 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 font-semibold"
		>
			Maybe later
		</button>
		<button
			type="button"
			onclick={handleUpdateNow}
			class="px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all duration-200 font-semibold"
		>
			Update now
		</button>
	</div>
</Dialog>
