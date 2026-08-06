<script lang="ts">
	import Dialog from '../overlay/Dialog.svelte';
	import Icon from '../display/Icon.svelte';
	import ReleaseNotesList from './ReleaseNotesList.svelte';
	import { updateState, hideRestartModal } from '$frontend/stores/ui/update.svelte';

	function handleClose() {
		hideRestartModal();
	}

	// Show the changelog entry matching the version that was just installed, if we have it.
	// Wrapped in a single-item array here (rather than inline in the template) so the
	// reference stays stable across unrelated re-renders — ReleaseNotesList reseeds its
	// expand/collapse state whenever the `releases` array reference changes.
	const installedReleaseNote = $derived(
		updateState.releaseNotes?.find(
			release => release.tag_name.replace(/^v/, '') === updateState.latestVersion
		) ?? null
	);
	const installedReleaseNoteList = $derived(installedReleaseNote ? [installedReleaseNote] : []);
</script>

<Dialog
	bind:isOpen={updateState.showRestartModal}
	onClose={handleClose}
	title="Updated to v{updateState.latestVersion}"
	type="success"
	confirmText="Got it"
	showCancel={false}
	maxWidth="max-w-lg"
>
	<div class="flex items-start space-x-4">
		<div class="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700/50 rounded-xl p-3">
			<Icon name="lucide:circle-check" class="w-6 h-6 text-green-600 dark:text-green-400" />
		</div>

		<div class="flex-1 space-y-3">
			<h2 class="text-lg font-semibold text-green-900 dark:text-green-100">
				Updated to v{updateState.latestVersion}
			</h2>

			<p class="text-base text-slate-600 dark:text-slate-400">
				To apply the update, restart the server:
			</p>

			<ol class="text-base text-slate-700 dark:text-slate-300 space-y-2.5 list-none pl-0">
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-sm font-bold shrink-0 mt-0.5">1</span>
					<span>Go to the terminal where you ran <code class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-sm font-mono">clopen</code> <span class="text-slate-500 dark:text-slate-500">(not the terminal inside Clopen)</span></span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-sm font-bold shrink-0 mt-0.5">2</span>
					<span>Press <kbd class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded text-sm font-mono">Ctrl+C</kbd> to stop the server</span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-sm font-bold shrink-0 mt-0.5">3</span>
					<span>Run <code class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-sm font-mono">clopen</code> again</span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-sm font-bold shrink-0 mt-0.5">4</span>
					<span>Refresh this browser tab</span>
				</li>
			</ol>

			{#if installedReleaseNote}
				<div class="pt-3 mt-1 border-t border-slate-200 dark:border-slate-700">
					<div class="text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">What's new</div>
					<div class="px-3 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg max-h-64 overflow-y-auto">
						<ReleaseNotesList releases={installedReleaseNoteList} defaultExpandedCount={0} />
					</div>
				</div>
			{/if}
		</div>
	</div>
</Dialog>
