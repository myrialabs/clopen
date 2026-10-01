<script lang="ts">
	/**
	 * "↑ 1/3 ↓  Discard  ↶ ↷" — the one way to work through an editor's changes,
	 * the same on every surface that shows them. Undo and Redo are buttons, not
	 * just shortcuts: on a phone there is no Ctrl+Z.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { HEADER_BUTTON, HEADER_ICON } from './header-styles';
	import type { ChangeControls, ChangeState } from './editor-changes';

	interface Props {
		state: ChangeState;
		controls: ChangeControls;
		/** Put away what the surface opened for the current change (the Files peek). */
		onHide?: () => void;
	}

	const { state, controls, onHide }: Props = $props();

	const hasHistory = $derived(!!controls.undo || !!controls.redo);
</script>

{#if state.count > 0 || hasHistory}
	<div class="flex items-center gap-1 shrink-0" role="group" aria-label="Changes">
		{#if state.count > 0}
			{#if onHide}
				<button type="button" class={HEADER_BUTTON} onclick={onHide} title="Hide change" aria-label="Hide change">
					<Icon name="lucide:x" class={HEADER_ICON} />
				</button>
			{/if}
			<button type="button" class={HEADER_BUTTON} onclick={controls.previous} title="Previous change" aria-label="Previous change">
				<Icon name="lucide:chevron-up" class={HEADER_ICON} />
			</button>
			<span class="px-0.5 text-center text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300" aria-live="polite">
				{state.index + 1}/{state.count}
			</span>
			<button type="button" class={HEADER_BUTTON} onclick={controls.next} title="Next change" aria-label="Next change">
				<Icon name="lucide:chevron-down" class={HEADER_ICON} />
			</button>
			{#if controls.discard && state.canDiscard}
				<button
					type="button"
					onclick={controls.discard}
					title="Discard this change"
					aria-label="Discard this change"
					class="flex p-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all duration-200"
				>
					<Icon name="lucide:circle-x" class={HEADER_ICON} />
				</button>
			{/if}
		{/if}
		{#if hasHistory}
			<button
				type="button"
				class="{HEADER_BUTTON} disabled:opacity-40 disabled:pointer-events-none"
				onclick={controls.undo}
				disabled={!state.canUndo}
				title="Undo"
				aria-label="Undo"
			>
				<Icon name="lucide:undo-2" class={HEADER_ICON} />
			</button>
			<button
				type="button"
				class="{HEADER_BUTTON} disabled:opacity-40 disabled:pointer-events-none"
				onclick={controls.redo}
				disabled={!state.canRedo}
				title="Redo"
				aria-label="Redo"
			>
				<Icon name="lucide:redo-2" class={HEADER_ICON} />
			</button>
		{/if}
	</div>
{/if}
