<script lang="ts">
	/**
	 * Change an item's state.
	 *
	 * A dropdown rather than a `<select>`. Three reasons, and only the last is
	 * about looks: a native select cannot carry the coloured status glyph that
	 * makes "closed as completed" and "closed as not planned" distinguishable at
	 * a glance; it cannot show which state the item is ALREADY in; and it is the
	 * one control on the row whose height the browser decides rather than us.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import MenuSurface from './MenuSurface.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import type { WorkItemStateCategory, WorkItemStateOption } from '$shared/types/work';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		options: WorkItemStateOption[];
		/** The provider's current state name, so the menu can mark it. */
		current: string;
	}

	const { options, current }: Props = $props();

	let open = $state(false);
	let applying = $state<string | null>(null);

	function glyph(category: WorkItemStateCategory): { icon: IconName; tone: string } {
		switch (category) {
			case 'closed':
				return { icon: 'lucide:circle-check', tone: 'text-violet-500' };
			case 'merged':
				return { icon: 'lucide:git-merge', tone: 'text-violet-500' };
			case 'draft':
				return { icon: 'lucide:git-pull-request-draft', tone: 'text-slate-400' };
			default:
				return { icon: 'lucide:circle-dot', tone: 'text-green-600 dark:text-green-400' };
		}
	}

	async function apply(option: WorkItemStateOption) {
		applying = option.value;
		try {
			await workStore.transition(option.value);
			open = false;
		} finally {
			applying = null;
		}
	}
</script>

<div class="relative" use:clickOutside={() => (open = false)}>
	<button
		type="button"
		class="flex items-center gap-1.5 h-8 px-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400"
		onclick={() => (open = !open)}
		title="Change state"
	>
		<Icon name="lucide:circle-dashed" class="w-3.5 h-3.5" />
		State
		<Icon name="lucide:chevron-down" class="w-3 h-3 text-slate-400" />
	</button>

	{#if open}
		<MenuSurface prefer="start" width="w-56" class="py-1">
			{#each options as option (option.value)}
				{@const look = glyph(option.category)}
				{@const isCurrent = option.label.toLowerCase() === current.toLowerCase()}
				<!--
					The current state is marked, not dimmed. It was drawn in
					slate-400/slate-600 — a colour a hair off the menu's own
					background in dark mode — so the one row that says where the
					item stands was the hardest row to read. It keeps full
					contrast and says so in a badge; being unclickable is what
					`disabled` and the cursor are for.
				-->
				<button
					type="button"
					class="flex items-center gap-2 w-full px-3 h-9 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 disabled:cursor-default
						{isCurrent ? 'bg-violet-500/5' : ''}"
					disabled={applying !== null || isCurrent}
					onclick={() => apply(option)}
				>
					{#if applying === option.value}
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 shrink-0 animate-spin" />
					{:else}
						<Icon name={look.icon} class="w-3.5 h-3.5 shrink-0 {look.tone}" />
					{/if}
					<span class="flex-1 {applying !== null && applying !== option.value ? 'opacity-60' : ''}">
						{option.label}
					</span>
					{#if isCurrent}
						<span class="shrink-0 px-1.5 py-0.5 text-[0.65rem] rounded-full border border-violet-500/40 text-violet-600 dark:text-violet-300">
							current
						</span>
					{/if}
				</button>
			{/each}
		</MenuSurface>
	{/if}
</div>
