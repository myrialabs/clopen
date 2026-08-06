<script lang="ts">
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { requestAiScrollReveal } from '$frontend/utils/ai-changes';

	interface Props {
		filePath: string;
		fileName?: string;
		operation?: string;
		badges?: string[];
		editKey?: string | null;
	}

	const { filePath, fileName, operation, badges = [], editKey = null }: Props = $props();

	const displayFileName = $derived(fileName || filePath.split(/[/\\]/).pop() || filePath);

	function handleClick() {
		revealFile(filePath);
		if (editKey) requestAiScrollReveal(filePath, editKey);
	}
</script>

<button
	type="button"
	class="space-y-0.5 text-sm w-full text-left hover:opacity-75 transition-opacity"
	onclick={handleClick}
	title={filePath}
>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		{#if operation}
			<span class="text-slate-500 dark:text-slate-400 shrink-0">{operation}:</span>
		{/if}
		<span class="font-mono font-medium text-slate-800 dark:text-slate-200">{displayFileName}</span>
		{#each badges as badge}
			<span class="text-xs text-slate-500 dark:text-slate-400">{badge}</span>
		{/each}
	</div>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-400 dark:text-slate-500 text-xs">{filePath}</span>
	</div>
</button>
