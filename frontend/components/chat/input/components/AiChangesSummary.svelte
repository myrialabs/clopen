<script lang="ts">
	/**
	 * What this chat has changed, one row at the top of the composer.
	 *
	 * Inside the input box rather than floating above it, and that placement is
	 * the point: a pill hovering over the conversation covered the last message,
	 * and during a turn it stacked under the loading pill until the two of them
	 * had eaten the space between the chat and the input. As a row of the
	 * composer it takes the width it already has and covers nothing.
	 *
	 * Hidden entirely when the chat has changed nothing: an empty counter is
	 * noise on every new conversation.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { aiChangesState } from '$frontend/stores/features/ai-changes.svelte';
	import { openAiChanges } from '$frontend/stores/ui/ai-changes-modal.svelte';

	const summary = $derived.by(() => {
		const paths = new Set<string>();
		let insertions = 0;
		let deletions = 0;
		let running = false;
		for (const turn of aiChangesState.turns) {
			if (turn.checkpointMessageId === null) running = true;
			for (const file of turn.files) {
				paths.add(file.path);
				insertions += file.insertions;
				deletions += file.deletions;
			}
		}
		return { files: paths.size, insertions, deletions, running };
	});
</script>

{#if summary.files > 0}
	<button
		type="button"
		class="group flex items-center gap-2 w-full px-4 py-1.5 text-left border-b border-slate-200 dark:border-slate-700 hover:bg-violet-500/5 transition-colors"
		onclick={() => openAiChanges()}
		title="Review every file this chat changed"
	>
		<Icon
			name="lucide:sparkles"
			class="w-3.5 h-3.5 shrink-0 text-violet-500 dark:text-violet-400 {summary.running
				? 'animate-pulse'
				: ''}"
		/>
		<span class="text-xs font-medium text-slate-600 dark:text-slate-300">
			{summary.files}
			{summary.files === 1 ? 'file' : 'files'} changed
		</span>
		<span class="text-xs text-emerald-600 dark:text-emerald-400">+{summary.insertions}</span>
		<span class="text-xs text-red-500">-{summary.deletions}</span>
		<span
			class="ml-auto flex items-center gap-0.5 text-xs text-slate-400 dark:text-slate-500 group-hover:text-violet-500 dark:group-hover:text-violet-400 transition-colors"
		>
			Review
			<Icon name="lucide:chevron-right" class="w-3 h-3" />
		</span>
	</button>
{/if}
