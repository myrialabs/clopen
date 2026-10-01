<script lang="ts">
	/**
	 * One action on an editor header's bar: a plain icon button, a link, or —
	 * when the action carries choices — a button that opens them in a menu.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import ChoiceRows from './ChoiceRows.svelte';
	import { actionClass, HEADER_ICON } from './header-styles';
	import type { HeaderAction } from './header-actions';

	interface Props {
		action: HeaderAction;
	}

	const { action }: Props = $props();

	let open = $state(false);
</script>

{#snippet face()}
	{#if action.busy}
		<div class="{HEADER_ICON} border-2 border-current border-t-transparent rounded-full animate-spin"></div>
	{:else}
		<Icon name={action.icon} class={HEADER_ICON} />
	{/if}
{/snippet}

{#if action.choices}
	<div class="relative shrink-0" use:clickOutside={() => (open = false)}>
		<button
			type="button"
			class="{actionClass(action.tone, action.active)} !px-1.5 gap-0.5"
			onclick={() => (open = !open)}
			disabled={action.disabled}
			title={action.label}
			aria-label={action.label}
			aria-haspopup="menu"
			aria-expanded={open}
		>
			{@render face()}
			<Icon name="lucide:chevron-down" class="w-2.5 h-2.5 self-center opacity-70" />
		</button>
		{#if open}
			<MenuSurface width="w-64" class="py-1">
				<ChoiceRows choices={action.choices} heading={action.label} onPick={() => (open = false)} />
			</MenuSurface>
		{/if}
	</div>
{:else if action.href}
	<a
		href={action.href}
		target="_blank"
		rel="noreferrer noopener"
		class="{actionClass(action.tone, action.active)} no-underline"
		title={action.label}
		aria-label={action.label}
	>
		{@render face()}
	</a>
{:else}
	<button
		type="button"
		class={actionClass(action.tone, action.active)}
		onclick={action.onclick}
		disabled={action.disabled}
		aria-pressed={action.active === undefined ? undefined : action.active}
		title={action.label}
		aria-label={action.label}
	>
		{@render face()}
	</button>
{/if}
