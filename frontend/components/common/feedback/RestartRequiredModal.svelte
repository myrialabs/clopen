<script lang="ts">
	import Dialog from '../overlay/Dialog.svelte';
	import Icon from '../display/Icon.svelte';
	import { updateState, hideRestartModal } from '$frontend/stores/ui/update.svelte';

	function handleClose() {
		hideRestartModal();
	}
</script>

<Dialog
	bind:isOpen={updateState.showRestartModal}
	onClose={handleClose}
	title="Updated to v{updateState.latestVersion}"
	type="success"
	confirmText="Got it"
	showCancel={false}
>
	<div class="flex items-start space-x-4">
		<div class="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700/50 rounded-xl p-3">
			<Icon name="lucide:circle-check" class="w-6 h-6 text-green-600 dark:text-green-400" />
		</div>

		<div class="flex-1 space-y-3">
			<h3 class="text-lg font-semibold text-green-900 dark:text-green-100">
				Updated to v{updateState.latestVersion}
			</h3>

			<p class="text-sm text-slate-600 dark:text-slate-400">
				To apply the update, restart the server:
			</p>

			<ol class="text-sm text-slate-700 dark:text-slate-300 space-y-2.5 list-none pl-0">
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs font-bold shrink-0 mt-0.5">1</span>
					<span>Go to the terminal where you ran <code class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs font-mono">clopen</code> <span class="text-slate-500 dark:text-slate-500">(not the terminal inside Clopen)</span></span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs font-bold shrink-0 mt-0.5">2</span>
					<span>Press <kbd class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded text-xs font-mono">Ctrl+C</kbd> to stop the server</span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs font-bold shrink-0 mt-0.5">3</span>
					<span>Run <code class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs font-mono">clopen</code> again</span>
				</li>
				<li class="flex items-start gap-2.5">
					<span class="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs font-bold shrink-0 mt-0.5">4</span>
					<span>Refresh this browser tab</span>
				</li>
			</ol>
		</div>
	</div>
</Dialog>
