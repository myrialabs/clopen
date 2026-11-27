<!--
  The `@` picker. Everything that can be mentioned is listed by group: the
  message's own files, matches from the workspace, and the lists that can be
  opened (Terminals, Commits, a database…). Opening a list shows it in place,
  with a way back. The composer owns the keys; this only draws.
-->
<script lang="ts" module>
	import type { IconName } from '$shared/types/ui/icons';

	export interface MentionItem {
		/** Unique within the list. */
		key: string;
		/** Group heading the item is listed under. */
		group: string;
		/** The `@N` an attachment already has; absent for what is not attached yet. */
		token?: string;
		label: string;
		/** Every row has one, so the list reads evenly. */
		detail: string;
		icon: IconName;
		thumbnailUrl?: string;
		/** Opens a list rather than being picked. */
		browse?: boolean;
	}
</script>

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fitAbove } from '$frontend/utils/fit-above';

	interface Props {
		items: MentionItem[];
		activeIndex: number;
		/** Rows are still being looked up. */
		loading?: boolean;
		/** The list that was opened, if one was; shows a way back to the root. */
		title?: string | null;
		/** What was typed after `@`, named in the header while it is looked up. */
		query?: string;
		onselect: (item: MentionItem) => void;
		onhover: (index: number) => void;
		onback?: () => void;
	}

	const { items, activeIndex, loading = false, title = null, query = '', onselect, onhover, onback }: Props = $props();

	const status = $derived(loading ? (query ? `Searching “${query}”…` : 'Looking…') : query ? `Results for “${query}”` : '');

	let list = $state<HTMLDivElement>();

	/** The header, its border, and air from the container's edge. */
	const CHROME = 36 + 1 + 12;
	// Keep the highlighted item in view while arrowing through a long list.
	$effect(() => {
		const active = list?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`);
		active?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div
	data-fit-above-menu
	class="absolute bottom-full left-0 mb-2 w-full max-w-md z-50 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
	role="listbox"
	aria-label="Mention"
>
	<!-- Always there, so a search in progress shows wherever the list is scrolled -->
	<div class="relative flex items-center gap-1.5 h-9 px-1.5 border-b border-slate-100 dark:border-slate-800">
		{#if title}
			<button
				type="button"
				class="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors border-none bg-transparent"
				onmousedown={(e) => { e.preventDefault(); onback?.(); }}
				title="Back (Esc)"
				aria-label="Back"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
			<span class="min-w-0 shrink-0 max-w-[45%] truncate text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</span>
		{:else}
			<span class="inline-flex items-center justify-center w-7 h-7 shrink-0 text-violet-600 dark:text-violet-400">
				<Icon name="lucide:at-sign" class="w-4 h-4" />
			</span>
			<span class="shrink-0 text-xs font-semibold text-slate-700 dark:text-slate-200">Mention</span>
		{/if}
		<span class="min-w-0 flex-1 truncate text-[11px] text-slate-500" aria-live="polite">{status}</span>
		{#if loading}
			<Icon name="lucide:loader-circle" class="mr-1.5 w-3.5 h-3.5 shrink-0 text-violet-500 animate-spin" />
		{/if}
		{#if loading}
			<span class="mention-progress absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden="true"><span></span></span>
		{/if}
	</div>
	<div bind:this={list} use:fitAbove={{ max: 288, chrome: CHROME, key: items.length + (loading ? 'l' : '') + (title ?? '') }} class="overflow-y-auto py-1 transition-opacity {loading && items.length > 0 ? 'opacity-60' : ''}">
		{#each items as item, i (item.key)}
			{#if i === 0 || items[i - 1].group !== item.group}
				<div class="px-3 pt-1.5 pb-1 text-3xs font-semibold uppercase tracking-wide text-slate-400">{item.group}</div>
			{/if}
			<button
				type="button"
				role="option"
				aria-selected={i === activeIndex}
				data-mention-index={i}
				class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors border-none
					{i === activeIndex ? 'bg-violet-500/10' : 'bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800'}"
				onmousedown={(e) => { e.preventDefault(); onselect(item); }}
				onmousemove={() => onhover(i)}
			>
				<span class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800">
					{#if item.thumbnailUrl}
						<img src={item.thumbnailUrl} alt="" class="w-full h-full object-cover" />
					{:else}
						<Icon name={item.icon} class="w-4.5 h-4.5 text-slate-600 dark:text-slate-300" />
					{/if}
				</span>
				{#if item.token}
					<span class="font-mono text-xs font-semibold text-violet-600 dark:text-violet-400 shrink-0 min-w-7">{item.token}</span>
				{/if}
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-slate-900 dark:text-slate-100 truncate">{item.label}</span>
					{#if item.detail}
						<span class="block text-[11px] text-slate-500 truncate">{item.detail}</span>
					{/if}
				</span>
				{#if item.browse}
					<Icon name="lucide:chevron-right" class="w-4 h-4 shrink-0 text-slate-400" />
				{/if}
			</button>
		{:else}
			<div class="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
				{#if loading}
					<Icon name="lucide:loader-circle" class="w-4 h-4 text-violet-500 animate-spin" />
					Looking…
				{:else}
					Nothing matches
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.mention-progress > span {
		position: absolute;
		inset-block: 0;
		width: 35%;
		background: rgb(139 92 246);
		animation: mention-progress 1s ease-in-out infinite;
	}

	@keyframes mention-progress {
		from {
			left: -35%;
		}
		to {
			left: 100%;
		}
	}
</style>
