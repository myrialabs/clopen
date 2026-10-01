<script lang="ts">
	/**
	 * The actions of an editor header, as many as fit — the rest wait in a "⋯"
	 * menu. The header measures the room it leaves, so a narrow panel on a wide
	 * screen collapses just as a phone does.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import ChoiceRows from './ChoiceRows.svelte';
	import HeaderActionButton from './HeaderActionButton.svelte';
	import { HEADER_BUTTON, HEADER_ICON } from './header-styles';
	import { splitActions, type HeaderAction } from './header-actions';

	interface Props {
		actions: HeaderAction[];
		/** Pixels the header leaves for the bar; 0 until it has measured. */
		room: number;
		class?: string;
	}

	const { actions, room, class: extra = '' }: Props = $props();

	let open = $state(false);

	const split = $derived(splitActions(actions, room));

	const rowClass =
		'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 disabled:opacity-50 disabled:pointer-events-none no-underline';

	// Nothing to hold any more: the menu has no business staying open.
	$effect(() => {
		if (split.overflow.length === 0) open = false;
	});
</script>

<!-- Hidden until the first measurement, or every action would flash into the menu. -->
<div class="flex items-center justify-end gap-1 {room === 0 ? 'invisible' : ''} {extra}">
	{#each split.visible as action (action.id)}
		<HeaderActionButton {action} />
	{/each}

	{#if split.overflow.length > 0}
		<div class="relative shrink-0" use:clickOutside={() => (open = false)}>
			<button
				type="button"
				class={HEADER_BUTTON}
				onclick={() => (open = !open)}
				title="More"
				aria-label="More"
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<Icon name="lucide:ellipsis" class={HEADER_ICON} />
			</button>
			{#if open}
				<MenuSurface width="w-64" class="py-0.5">
					{#each split.overflow as action (action.id)}
						{#if action.choices}
							<ChoiceRows choices={action.choices} heading={action.label} card onPick={() => (open = false)} />
						{:else if action.href}
							<a
								href={action.href}
								target="_blank"
								rel="noreferrer noopener"
								class={rowClass}
								onclick={() => (open = false)}
							>
								<Icon name={action.icon} class="w-3.5 h-3.5 shrink-0" />
								<span class="min-w-0 flex-1 truncate">{action.label}</span>
							</a>
						{:else}
							<button
								type="button"
								class={rowClass}
								disabled={action.disabled}
								onclick={() => {
									action.onclick?.();
									open = false;
								}}
							>
								<Icon name={action.icon} class="w-3.5 h-3.5 shrink-0" />
								<span class="min-w-0 flex-1 truncate">{action.label}</span>
								{#if action.active}
									<Icon name="lucide:check" class="w-3.5 h-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
								{/if}
							</button>
						{/if}
					{/each}
				</MenuSurface>
			{/if}
		</div>
	{/if}
</div>
