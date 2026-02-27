<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	interface Props {
		stagedCount: number;
		isCommitting: boolean;
		onCommit: (message: string) => void;
	}

	const { stagedCount, isCommitting, onCommit }: Props = $props();

	let commitMessage = $state('');
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	function handleCommit() {
		if (!commitMessage.trim() || stagedCount === 0) return;
		onCommit(commitMessage.trim());
		commitMessage = '';
		autoResize();
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			handleCommit();
		}
	}

	function autoResize() {
		if (!textareaEl) return;
		// Reset to single line to measure content
		textareaEl.style.height = 'auto';
		// Line height is ~20px for text-xs, so 5 lines max = 100px
		const lineHeight = 20;
		const maxHeight = lineHeight * 5;
		const scrollHeight = textareaEl.scrollHeight;
		textareaEl.style.height = Math.min(scrollHeight, maxHeight) + 'px';
	}

	function handleInput() {
		autoResize();
	}
</script>

<div class="px-2 pb-2">
	<div class="flex flex-col gap-1.5">
		<textarea
			bind:this={textareaEl}
			bind:value={commitMessage}
			placeholder="Commit message..."
			class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-none outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 transition-colors overflow-hidden"
			rows="1"
			style="height: 27px"
			onkeydown={handleKeydown}
			oninput={handleInput}
			disabled={isCommitting}
		></textarea>
		<button
			type="button"
			class="flex items-center justify-center gap-1.5 w-full py-1.5 px-3 rounded-md text-xs font-medium transition-all duration-150
				{stagedCount > 0 && commitMessage.trim() && !isCommitting
					? 'bg-violet-600 text-white hover:bg-violet-700 cursor-pointer'
					: 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'}"
			onclick={handleCommit}
			disabled={stagedCount === 0 || !commitMessage.trim() || isCommitting}
		>
			{#if isCommitting}
				<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
				<span>Committing...</span>
			{:else}
				<Icon name="lucide:check" class="w-3.5 h-3.5" />
				<span>Commit{stagedCount > 0 ? ` (${stagedCount})` : ''}</span>
			{/if}
		</button>
	</div>
</div>
