<!--
	A short list of mutually exclusive choices, one bordered card per option.
	Shared by the engine account flows (auth mode, login method, a login
	prompt's options) so every panel offers a choice the same way.
-->
<script lang="ts" generics="T extends string">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Option {
		value: T;
		label: string;
		icon?: IconName;
		/** One line under the label. */
		description?: string;
		/** Greyed out and not selectable; `description` should say why. */
		disabled?: boolean;
	}

	interface Props {
		options: Option[];
		value: T | null;
		label: string;
	}

	let { options, value = $bindable(), label }: Props = $props();
</script>

<div class="space-y-2" role="radiogroup" aria-label={label}>
	{#each options as option (option.value)}
		{@const selected = value === option.value}
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			disabled={option.disabled}
			onclick={() => { value = option.value; }}
			class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed
				{selected
				? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100'
				: 'cursor-pointer border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 enabled:hover:border-violet-400'}"
		>
			<span class="relative shrink-0 flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {selected ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
				<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {selected ? 'scale-100' : 'scale-0'}"></span>
			</span>
			{#if option.icon}
				<Icon name={option.icon} class="w-3.5 h-3.5 shrink-0" />
			{/if}
			<span class="min-w-0">
				<span class="block">{option.label}</span>
				{#if option.description}
					<span class="block text-xs font-normal text-slate-500 dark:text-slate-400">{option.description}</span>
				{/if}
			</span>
		</button>
	{/each}
</div>
