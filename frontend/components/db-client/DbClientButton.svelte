<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';

	interface Props {
		collapsed?: boolean;
		mobile?: boolean;
		onClick: () => void;
	}

	const { collapsed = false, mobile = false, onClick }: Props = $props();

	const liveCount = $derived(dbClientStore.liveCount);
	const hasLive = $derived(liveCount > 0);
</script>

{#if collapsed}
	<button
		type="button"
		class="flex items-center justify-center bg-transparent border-none text-slate-500 cursor-pointer transition-all duration-150 relative
			{mobile
			? 'w-9 h-8 rounded-md active:bg-violet-500/10'
			: 'w-9 h-9 rounded-lg hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
		onclick={onClick}
		aria-label="DB Client"
		title="DB Client"
	>
		<Icon name="lucide:database" class="{mobile ? 'w-4.5 h-4.5' : 'w-5 h-5'}" />
		{#if hasLive}
			<span
				class="absolute top-0.5 right-0.5 min-w-4 h-4 px-0.5 rounded-full bg-emerald-500 text-white text-3xs font-bold flex items-center justify-center border-2 border-slate-50 dark:border-slate-900/95"
			>
				{liveCount}
			</span>
		{/if}
	</button>
{:else}
	<button
		type="button"
		class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
		onclick={onClick}
	>
		<div class="relative">
			<Icon name="lucide:database" class="w-4 h-4" />
			{#if hasLive}
				<span
					class="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full border-2 border-slate-50 dark:border-slate-900/95"
				></span>
			{/if}
		</div>
		<span class="flex-1 text-left">DB Client</span>
		{#if hasLive}
			<span class="text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
				{liveCount}
			</span>
		{/if}
	</button>
{/if}
