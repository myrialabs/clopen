<script lang="ts">
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';
	import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';

	interface Props {
		filePath: string;
		fileName?: string;
		operation?: string;
		badges?: string[];
		/**
		 * Optional custom click handler. When provided, the file path is no
		 * longer revealed in the Files panel on click — the handler takes
		 * over. Used by EditTool to open a diff view of the AI's edit
		 * (matching the checkpoint banner behaviour).
		 */
		onClick?: () => void;
	}

	const { filePath, fileName, operation, badges = [], onClick }: Props = $props();

	const displayFileName = $derived(fileName || filePath.split(/[/\\]/).pop() || filePath);

	function handleClick() {
		if (onClick) {
			onClick();
			return;
		}
		const visiblePanels = getVisiblePanels(workspaceState.layout);
		if (visiblePanels.includes('files')) requestRevealFile(filePath);
	}

	/** Classify a badge so `+N` renders green and `-N` renders red —
	 *  matches the diff stats colour used elsewhere in the UI. */
	function badgeClass(badge: string): string {
		if (badge.startsWith('+')) return 'text-emerald-600 dark:text-emerald-400 font-semibold';
		if (badge.startsWith('-')) return 'text-red-600 dark:text-red-400 font-semibold';
		return 'text-slate-500 dark:text-slate-400';
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
			<span class="text-xs {badgeClass(badge)}">{badge}</span>
		{/each}
	</div>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-400 dark:text-slate-500 text-xs">{filePath}</span>
	</div>
</button>
