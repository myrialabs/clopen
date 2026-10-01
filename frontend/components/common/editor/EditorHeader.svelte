<script lang="ts">
	/**
	 * The bar over any editor: what is open, where the reader is among its
	 * changes, and what can be done. The Files editor, the Git diff, the chat's
	 * changes and a pull request's files all use it, so moving between them
	 * never means relearning where a control lives.
	 *
	 * It lays itself out against its own width, not the window's, because an
	 * editor often sits in a panel far narrower than the screen. Wide: one row.
	 * Narrow: the title and Close on top, the controls on a row of their own —
	 * and whatever actions do not fit there wait in a "⋯" menu.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ChangeToolbar from './ChangeToolbar.svelte';
	import OverflowActions from './OverflowActions.svelte';
	import { HEADER_ICON } from './header-styles';
	import { ACTION_SLOT, type HeaderAction } from './header-actions';
	import type { ChangeControls, ChangeState } from './editor-changes';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		icon: IconName;
		title: string;
		/** The path, or the path and size — the second line under the title. */
		subtitle?: string;
		titleId?: string;
		/** Before the icon, e.g. a back button on a phone. */
		leading?: Snippet;
		/** Small facts beside the controls: a turn, a status badge. */
		meta?: Snippet;
		/** The surface's own actions, after the change controls; the ones that do not fit go into "⋯". */
		actions?: HeaderAction[];
		changes?: { state: ChangeState; controls: ChangeControls; onHide?: () => void };
		onClose?: () => void;
	}

	const { icon, title, subtitle, titleId, leading, meta, actions = [], changes, onClose }: Props = $props();

	/** The divider between the change controls and the actions, with the space around it. */
	const DIVIDER_WIDTH = 25;

	let clusterWidth = $state(0);
	let leadWidth = $state(0);

	// With too little room beside the change controls the actions get a row of
	// their own, instead of squeezing into a sliver.
	const stacked = $derived(leadWidth > 0 && clusterWidth - leadWidth - DIVIDER_WIDTH < ACTION_SLOT * 2);
	const room = $derived(leadWidth === 0 || stacked ? clusterWidth : clusterWidth - leadWidth - DIVIDER_WIDTH);
</script>

<div class="@container flex-shrink-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5">
		<div class="order-1 flex items-center gap-2 sm:gap-3 min-w-[8rem] flex-[1_1_0] @xl:flex-[2_1_0]">
			{@render leading?.()}
			<Icon name={icon} class="w-7 h-7 shrink-0" />
			<div class="min-w-0 flex-1">
				<h3 id={titleId} class="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
					{title}
				</h3>
				{#if subtitle}
					<p class="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5" title={subtitle}>
						{subtitle}
					</p>
				{/if}
			</div>
		</div>

		{#if onClose}
			<button
				type="button"
				class="order-2 @xl:order-3 flex shrink-0 p-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all duration-200"
				onclick={onClose}
				title="Close"
				aria-label="Close"
			>
				<Icon name="lucide:x" class={HEADER_ICON} />
			</button>
		{/if}

		<!-- One right-aligned cluster: what is happening, then what can be done. -->
		<div
			class="order-3 @xl:order-2 flex flex-wrap items-center justify-end gap-1 min-w-0 flex-[1_1_100%] @xl:flex-[3_1_0]"
			bind:clientWidth={clusterWidth}
		>
			<div class="flex items-center gap-1 shrink-0 empty:hidden" bind:clientWidth={leadWidth}>
				{@render meta?.()}
				{#if changes}
					<ChangeToolbar state={changes.state} controls={changes.controls} onHide={changes.onHide} />
				{/if}
			</div>
			{#if actions.length > 0}
				{#if leadWidth > 0 && !stacked}
					<span class="w-px h-5 mx-2 bg-slate-200 dark:bg-slate-700" aria-hidden="true"></span>
				{/if}
				<OverflowActions {actions} {room} class={stacked ? 'basis-full' : ''} />
			{/if}
		</div>
	</div>
</div>
