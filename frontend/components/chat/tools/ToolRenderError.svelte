<script lang="ts">
	/**
	 * Fallback rendered when a tool component throws.
	 *
	 * Tool inputs come from the engine and can violate their declared schema —
	 * a call rejected by the harness is still emitted and still persisted, so a
	 * renderer that trusts its input crashes on every load once such a block is
	 * in the history. Because the active session is restored automatically, that
	 * used to take the whole app down permanently. Containing the failure here
	 * keeps the damage to a single bubble and surfaces the underlying error
	 * instead of hiding it.
	 */
	import type { ToolUseBlock } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	const { toolInput, error, reset }: {
		toolInput: ToolUseBlock;
		error: unknown;
		reset: () => void;
	} = $props();

	const reason = $derived(error instanceof Error ? error.message : String(error));

	const rawInput = $derived.by(() => {
		try {
			return JSON.stringify(toolInput.input, null, 2);
		} catch {
			return String(toolInput.input);
		}
	});
</script>

<div class="bg-white dark:bg-slate-800 rounded-lg border border-red-200/60 dark:border-red-800/40 p-3 space-y-2">
	<div class="flex items-center gap-2">
		<Icon name="lucide:triangle-alert" class="text-red-500 w-4 h-4 shrink-0" />
		<span class="text-sm font-medium text-slate-700 dark:text-slate-200">
			Couldn't display this {toolInput.name} call
		</span>
		<button
			class="ml-auto text-xs px-2 py-0.5 rounded border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
			onclick={reset}
		>
			Retry
		</button>
	</div>

	{#if toolInput.result?.content}
		<p class="text-xs text-red-500 dark:text-red-400 whitespace-pre-wrap break-words">
			{toolInput.result.content}
		</p>
	{/if}

	<details class="text-xs text-slate-500 dark:text-slate-400">
		<summary class="cursor-pointer select-none">Details</summary>
		<p class="mt-1 font-mono break-words">{reason}</p>
		<pre class="mt-1 p-2 rounded bg-slate-50 dark:bg-slate-900 overflow-x-auto">{rawInput}</pre>
	</details>
</div>
