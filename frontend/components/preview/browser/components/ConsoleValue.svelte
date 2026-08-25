<script lang="ts">
	/**
	 * One console argument, rendered DevTools-style.
	 *
	 * Values arrive pre-flattened from the page (see BrowserConsoleValue), so
	 * expanding a node is a pure render of data already held — no round-trip and
	 * no live handle that could go stale when the page navigates.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Self from './ConsoleValue.svelte';
	import type { BrowserConsoleValue } from '$frontend/utils/native-ui';

	let {
		value,
		depth = 0,
		/** Top-level strings print bare, the way `console.log('hi')` shows `hi`. */
		bare = false
	}: { value: BrowserConsoleValue; depth?: number; bare?: boolean } = $props();

	let expanded = $state(false);

	const expandable = $derived(!!value.entries && value.entries.length > 0);

	const toneClass = $derived.by(() => {
		switch (value.type) {
			case 'string':
				return bare ? 'text-slate-700 dark:text-slate-200' : 'text-rose-600 dark:text-rose-400';
			case 'number':
			case 'bigint':
				return 'text-sky-600 dark:text-sky-400';
			case 'boolean':
				return 'text-purple-600 dark:text-purple-400';
			case 'null':
			case 'undefined':
				return 'text-slate-400 dark:text-slate-500';
			case 'function':
				return 'text-amber-600 dark:text-amber-400 italic';
			case 'error':
				return 'text-red-600 dark:text-red-400';
			case 'node':
				return 'text-teal-600 dark:text-teal-400';
			case 'regexp':
				return 'text-orange-600 dark:text-orange-400';
			default:
				return 'text-slate-600 dark:text-slate-300';
		}
	});

	const label = $derived(
		value.type === 'string' && !bare ? `"${value.preview}"` : value.preview
	);
</script>

<span class="inline-flex flex-col align-top max-w-full">
	<span class="inline-flex items-start gap-1 min-w-0">
		{#if expandable}
			<button
				type="button"
				class="mt-0.5 flex shrink-0 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
				onclick={() => (expanded = !expanded)}
				aria-expanded={expanded}
				title={expanded ? 'Collapse' : 'Expand'}
			>
				<Icon name={expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3" />
			</button>
		{/if}
		<span class="{toneClass} break-words whitespace-pre-wrap min-w-0">{label}</span>
	</span>

	{#if expandable && expanded}
		<span class="flex flex-col gap-0.5 pl-4 mt-0.5 border-l border-slate-200 dark:border-slate-700">
			{#each value.entries ?? [] as entry (entry.key)}
				<span class="flex items-start gap-1.5 min-w-0">
					<span class="shrink-0 text-violet-600 dark:text-violet-400">{entry.key}:</span>
					<Self value={entry.value} depth={depth + 1} />
				</span>
			{/each}
			{#if value.truncated}
				<span class="text-slate-400 dark:text-slate-500 italic">…more entries not shown</span>
			{/if}
		</span>
	{/if}
</span>
