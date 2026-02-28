<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { tunnelStore } from '$frontend/lib/stores/features/tunnel.svelte';

	interface Props {
		collapsed?: boolean;
		onClick: () => void;
	}

	const { collapsed = false, onClick }: Props = $props();

	const activeTunnels = $derived(tunnelStore.tunnels);
	const hasActiveTunnels = $derived(activeTunnels.length > 0);
</script>

{#if collapsed}
	<!-- Collapsed: Icon Only -->
	<button
		type="button"
		class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 relative"
		onclick={onClick}
		aria-label="Public Tunnel"
		title="Public Tunnel"
	>
		<Icon name="lucide:cloud-upload" class="w-5 h-5" />
		{#if hasActiveTunnels}
			<span
				class="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full border-2 border-slate-50 dark:border-slate-900/95"
			></span>
		{/if}
	</button>
{:else}
	<!-- Expanded: Full Width -->
	<button
		type="button"
		class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
		onclick={onClick}
	>
		<div class="relative">
			<Icon name="lucide:cloud-upload" class="w-4 h-4" />
			{#if hasActiveTunnels}
				<span
					class="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full border-2 border-slate-50 dark:border-slate-900/95"
				></span>
			{/if}
		</div>
		<span class="flex-1 text-left">Public Tunnel</span>
		{#if hasActiveTunnels}
			<span class="text-xs text-green-600 dark:text-green-400 font-semibold">
				{activeTunnels.length}
			</span>
		{/if}
	</button>
{/if}
