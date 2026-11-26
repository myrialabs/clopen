<!--
  The `@` picker. Whatever can be mentioned in a message is listed here by
  group — attachments today; files, sessions and the like can be added as more
  groups without touching the composer's key handling.
-->
<script lang="ts" module>
	import type { IconName } from '$shared/types/ui/icons';

	export interface MentionItem {
		/** Unique within the list. */
		key: string;
		/** Group heading the item is listed under. */
		group: string;
		/** What is written into the message, e.g. `@2`. */
		token: string;
		label: string;
		detail?: string;
		icon: IconName;
		thumbnailUrl?: string;
	}
</script>

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		items: MentionItem[];
		activeIndex: number;
		onselect: (item: MentionItem) => void;
		onhover: (index: number) => void;
	}

	const { items, activeIndex, onselect, onhover }: Props = $props();

	let list = $state<HTMLDivElement>();

	// Keep the highlighted item in view while arrowing through a long list.
	$effect(() => {
		const active = list?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`);
		active?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div
	class="absolute bottom-full left-0 mb-2 w-full max-w-md z-50 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
	role="listbox"
	aria-label="Mention"
>
	<div bind:this={list} class="max-h-64 overflow-y-auto py-1">
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
						<Icon name={item.icon} class="w-5 h-5" />
					{/if}
				</span>
				<span class="font-mono text-xs font-semibold text-violet-600 dark:text-violet-400 shrink-0 min-w-7">{item.token}</span>
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-slate-900 dark:text-slate-100 truncate">{item.label}</span>
					{#if item.detail}
						<span class="block text-[11px] text-slate-500 truncate">{item.detail}</span>
					{/if}
				</span>
			</button>
		{/each}
	</div>
</div>
