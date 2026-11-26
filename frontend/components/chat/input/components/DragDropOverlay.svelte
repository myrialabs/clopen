<script lang="ts">
	import { fade } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		isDragging: boolean;
	}

	const { isDragging }: Props = $props();
</script>

<!--
  Covers the whole chat panel, so where the hint sits never depends on how
  many files are attached or how tall the message box has grown.
-->
{#if isDragging}
	<div
		class="absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-violet-500/70 bg-violet-500/10 backdrop-blur-[2px] pointer-events-none"
		transition:fade={{ duration: 120 }}
	>
		<div class="flex flex-col items-center gap-2 px-6 py-5 rounded-xl bg-white/95 dark:bg-slate-900/95 shadow-lg border border-violet-500/40 text-center">
			<Icon name="lucide:file-up" class="w-8 h-8 text-violet-500" />
			<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">Drop files to attach</span>
			<span class="text-xs text-slate-500 dark:text-slate-400">Images, PDFs or any other file</span>
		</div>
	</div>
{/if}
