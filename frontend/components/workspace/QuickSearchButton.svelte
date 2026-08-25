<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { openCommandPalette } from '$frontend/stores/ui/command-palette.svelte';
	import { isMac } from '$frontend/utils/platform';

	interface Props {
		collapsed?: boolean;
	}

	const { collapsed = false }: Props = $props();

	const modifierLabel = isMac() ? '⌘' : 'Ctrl+';
</script>

{#if collapsed}
	<!-- Collapsed: Icon Only -->
	<button
		type="button"
		class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
		onclick={openCommandPalette}
		aria-label="Quick search"
		title="Quick search ({modifierLabel}K)"
	>
		<Icon name="lucide:search" class="w-5 h-5" />
	</button>
{:else}
	<!-- Expanded: Full Width -->
	<button
		type="button"
		class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
		onclick={openCommandPalette}
	>
		<Icon name="lucide:search" class="w-4 h-4" />
		<span class="flex-1 text-left">Quick Search</span>
		<kbd class="text-3xs font-mono text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5">{modifierLabel}K</kbd>
	</button>
{/if}
