<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { WorkItem } from '$shared/types/work';

	interface Props {
		/** Issues and pull requests matching what follows the `#`. */
		items: WorkItem[];
		activeIndex: number;
		isLoading: boolean;
		serviceName: string;
		onselect: (item: WorkItem) => void;
		onhover: (index: number) => void;
	}

	const { items, activeIndex, isLoading, serviceName, onselect, onhover }: Props = $props();

	function iconOf(item: WorkItem): { icon: IconName; class: string } {
		if (item.stateCategory === 'merged') return { icon: 'lucide:git-merge', class: 'text-violet-500' };
		if (item.stateCategory === 'closed') return { icon: item.kind === 'pull-request' ? 'lucide:git-pull-request-closed' : 'lucide:circle-check', class: 'text-slate-400' };
		return { icon: item.kind === 'pull-request' ? 'lucide:git-pull-request' : 'lucide:circle-dot', class: 'text-green-600 dark:text-green-400' };
	}
</script>

<div
	class="absolute bottom-full left-0 mb-2 w-full max-w-xl z-50 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
	role="listbox"
	aria-label="Issues and pull requests"
>
	<div class="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wide text-slate-400">
		Attach from {serviceName}
	</div>
	<div class="max-h-64 overflow-y-auto pb-1">
		{#each items as item, i (`${item.kind}-${item.id}`)}
			{@const style = iconOf(item)}
			<button
				type="button"
				role="option"
				aria-selected={i === activeIndex}
				class="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors border-none
					{i === activeIndex ? 'bg-violet-500/10' : 'bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800'}"
				onmousedown={(e) => { e.preventDefault(); onselect(item); }}
				onmousemove={() => onhover(i)}
			>
				<Icon name={style.icon} class="w-4 h-4 mt-0.5 shrink-0 {style.class}" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-slate-900 dark:text-slate-100 truncate">
						<span class="font-mono text-slate-500">#{item.identifier}</span> {item.title}
					</span>
					<span class="block text-[11px] text-slate-500">{item.kind === 'pull-request' ? 'Pull request' : 'Issue'} · {item.state}</span>
				</span>
			</button>
		{/each}
		{#if isLoading && items.length === 0}
			<div class="flex items-center gap-2 px-3 py-2 text-xs text-slate-500"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />Searching…</div>
		{:else if items.length === 0}
			<div class="px-3 py-2 text-xs text-slate-500">Nothing matches.</div>
		{/if}
	</div>
</div>
