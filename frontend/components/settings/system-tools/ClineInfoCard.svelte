<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';

	// Cline ships as an in-process SDK (@cline/sdk), not a CLI — there is nothing
	// to install, update, or check. This card is READ-ONLY: it surfaces the bundled
	// version so System Tools stays the single place engine runtimes are reported,
	// without any install/refresh/update actions.

	let installed = $state(false);
	let version = $state<string | null>(null);
	let isLoading = $state(true);

	onMount(async () => {
		try {
			const res = await ws.http('engine:cline-status', {});
			installed = res.installed;
			version = res.version;
		} catch {
			installed = false;
		}
		isLoading = false;
	});
</script>

<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div>
			<h3 class="font-semibold text-slate-900 dark:text-slate-100">Cline</h3>
			<p class="text-xs text-slate-500 dark:text-slate-400">Bundled in-process SDK — no CLI to install</p>
		</div>

		{#if isLoading}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
				<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
				Checking...
			</span>
		{:else if installed}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
				<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
				Installed
			</span>
		{:else}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
				<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
				Not Available
			</span>
		{/if}
	</div>

	<div class="px-5 py-4 space-y-3">
		{#if isLoading}
			<div class="flex items-center justify-center py-6">
				<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{:else if installed}
			<div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
				<Icon name="lucide:tag" class="w-4 h-4 text-slate-400" />
				<span>Version: <span class="font-mono font-medium text-slate-900 dark:text-slate-100">{version || 'Unknown'}</span></span>
			</div>
			<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
				<Icon name="lucide:package" class="w-3.5 h-3.5 shrink-0" />
				<span class="font-mono truncate">@cline/sdk</span>
			</div>
			<p class="text-xs text-slate-500 dark:text-slate-400">
				Cline runs in-process as a library dependency, so there is nothing to install or update here — its version tracks Clopen's bundled package.
			</p>
		{/if}
	</div>
</div>
