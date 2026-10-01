<script lang="ts">
	/**
	 * The bar over any editor: what is open, where the reader is among its
	 * changes, and what can be done. The Files editor, the Git diff, the chat's
	 * changes and a pull request's files all use it, so moving between them
	 * never means relearning where a control lives.
	 *
	 * On a narrow screen the controls wrap under the title instead of crushing
	 * the file name to nothing.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ChangeToolbar from './ChangeToolbar.svelte';
	import { HEADER_ICON } from './header-styles';
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
		/** The surface's own actions, after the change controls. */
		actions?: Snippet;
		changes?: { state: ChangeState; controls: ChangeControls; onHide?: () => void };
		onClose?: () => void;
	}

	const { icon, title, subtitle, titleId, leading, meta, actions, changes, onClose }: Props = $props();
</script>

<div class="flex-shrink-0 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
	<div class="flex items-center gap-2 sm:gap-3 min-w-[10rem] flex-1">
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

	<div class="flex items-center gap-1.5 sm:gap-1 flex-shrink-0 ml-auto">
		{@render meta?.()}
		{#if changes}
			<ChangeToolbar state={changes.state} controls={changes.controls} onHide={changes.onHide} />
		{/if}
		{@render actions?.()}
		{#if onClose}
			<button
				type="button"
				class="flex p-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all duration-200"
				onclick={onClose}
				title="Close"
				aria-label="Close"
			>
				<Icon name="lucide:x" class={HEADER_ICON} />
			</button>
		{/if}
	</div>
</div>
