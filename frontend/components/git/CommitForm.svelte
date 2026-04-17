<script lang="ts">
	import { tick } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import ws from '$frontend/utils/ws';

	interface Props {
		stagedCount: number;
		isCommitting: boolean;
		onCommit: (message: string) => void;
	}

	const { stagedCount, isCommitting, onCommit }: Props = $props();

	let commitMessage = $state('');
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let isGenerating = $state(false);

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
		// Line height is ~20px for text-sm, so 5 lines max = 100px
		const lineHeight = 20;
		const maxHeight = lineHeight * 5;
		const scrollHeight = textareaEl.scrollHeight;
		const newHeight = Math.min(scrollHeight, maxHeight);
		textareaEl.style.height = newHeight + 'px';
		textareaEl.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
	}

	function handleInput() {
		autoResize();
	}

	async function generateCommitMessage() {
		const projectId = projectState.currentProject?.id;
		if (!projectId || stagedCount === 0 || isGenerating) return;

		isGenerating = true;
		try {
			const { useCustomModel, engine, provider, modelId, format } = settings.commitGenerator;
			const resolvedEngine = useCustomModel ? engine : settings.selectedEngine;
			const resolvedProvider = useCustomModel ? provider : settings.selectedProvider;
			const resolvedModel = useCustomModel ? modelId : settings.selectedModelId;
			const result = await ws.http('git:generate-commit-message', {
				projectId,
				engine: resolvedEngine,
				providerSlug: resolvedProvider,
				modelId: resolvedModel,
				format
			});
			commitMessage = result.message;
			await tick();
			autoResize();
		} catch (err) {
			showError('Generate Failed', err instanceof Error ? err.message : 'Failed to generate commit message');
		} finally {
			isGenerating = false;
		}
	}
</script>

<div class="px-2 py-2">
	<div class="flex flex-col gap-1.5">
		<div class="flex relative">
			<textarea
				bind:this={textareaEl}
				bind:value={commitMessage}
				placeholder="Commit message..."
				class="w-full px-2.5 py-2 pr-8 text-sm bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-none outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
				rows="1"
				style="overflow-y: hidden;"
				onkeydown={handleKeydown}
				oninput={handleInput}
				disabled={isCommitting || isGenerating}
			></textarea>
			<!-- AI generate button -->
			<button
				type="button"
				class="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 rounded transition-all duration-150
					{stagedCount > 0 && !isGenerating && !isCommitting
						? 'text-slate-400 hover:text-violet-500 hover:bg-violet-500/10 cursor-pointer'
						: 'text-slate-300 dark:text-slate-700 cursor-not-allowed'}"
				onclick={generateCommitMessage}
				disabled={stagedCount === 0 || isGenerating || isCommitting}
				title="Generate commit message with AI"
			>
				{#if isGenerating}
					<div class="w-3.5 h-3.5 border-2 border-violet-400/30 border-t-violet-500 rounded-full animate-spin"></div>
				{:else}
					<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
				{/if}
			</button>
		</div>
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
