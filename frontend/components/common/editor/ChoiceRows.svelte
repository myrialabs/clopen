<script lang="ts">
	/**
	 * The rows of a header menu: a radio-style list with optional headings and
	 * dividers. The gutter modes, a turn picker and the "⋯" overflow all list
	 * their choices this way. Among other rows (the overflow) a group sits in its
	 * own tinted card so it reads as one setting; alone in a menu it needs none.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { HeaderChoice } from './header-actions';

	interface Props {
		choices: HeaderChoice[];
		heading?: string;
		/** Set it apart from the rows around it. */
		card?: boolean;
		/** Called after a row is picked, so the menu can close. */
		onPick: () => void;
	}

	const { choices, heading, card = false, onPick }: Props = $props();
</script>

<div class={card ? 'mx-1 my-1 rounded-md bg-slate-100/70 dark:bg-slate-900/50 py-1' : ''}>
	{#if heading}
		<div class="px-3 pt-1 pb-1 text-2xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{heading}</div>
	{/if}
	{#each choices as choice, index (index)}
		{#if choice.kind === 'separator'}
			<div class="my-1 {card ? 'mx-3' : ''} border-t border-slate-200 dark:border-slate-700"></div>
		{:else if choice.kind === 'heading'}
			<div class="px-3 pt-1.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{choice.label}</div>
		{:else if choice.kind === 'subheading'}
			<div class="px-3 pt-1 pb-0.5 text-2xs text-slate-400 dark:text-slate-500">{choice.label}</div>
		{:else}
			<button
				type="button"
				class="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors hover:bg-violet-500/10 {choice.dim
					? 'text-slate-400 dark:text-slate-500'
					: 'text-slate-700 dark:text-slate-200'}"
				role="menuitemradio"
				aria-checked={!!choice.checked}
				title={choice.title}
				onclick={() => {
					choice.onSelect();
					onPick();
				}}
			>
				<Icon name="lucide:check" class="w-3.5 h-3.5 shrink-0 text-violet-600 dark:text-violet-400 {choice.checked ? '' : 'opacity-0'}" />
				{#if choice.prefix}
					<span class="shrink-0 text-slate-400 dark:text-slate-500">{choice.prefix}</span>
				{/if}
				<span class="min-w-0 flex-1 truncate">{choice.label}</span>
			</button>
		{/if}
	{/each}
</div>
