<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	interface Props {
		collapsed?: boolean;
		onClick: () => void;
	}

	const { collapsed = false, onClick }: Props = $props();
</script>

{#if collapsed}
	<!-- Collapsed: Icon Only -->
	<button
		type="button"
		class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 relative"
		onclick={onClick}
		aria-label="Source Control"
		title="Source Control"
	>
		<Icon name="lucide:git-branch" class="w-5 h-5" />
	</button>
{:else}
	<!-- Expanded: Full Width -->
	<button
		type="button"
		class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
		onclick={onClick}
	>
		<Icon name="lucide:git-branch" class="w-4 h-4" />
		<span class="flex-1 text-left">Source Control</span>
	</button>
{/if}
