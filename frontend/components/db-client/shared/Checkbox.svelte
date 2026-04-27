<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		checked: boolean;
		disabled?: boolean;
		indeterminate?: boolean;
		size?: 'sm' | 'md';
		ariaLabel?: string;
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		disabled = false,
		indeterminate = false,
		size = 'sm',
		ariaLabel,
		onchange
	}: Props = $props();

	const dim = $derived(size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5');
	const iconDim = $derived(size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5');

	function toggle(): void {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}

	function onKey(e: KeyboardEvent): void {
		if (disabled) return;
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			toggle();
		}
	}
</script>

<button
	type="button"
	role="checkbox"
	aria-checked={indeterminate ? 'mixed' : checked}
	aria-label={ariaLabel}
	{disabled}
	class="inline-flex items-center justify-center {dim} rounded border transition-colors shrink-0
		{checked || indeterminate
			? 'bg-violet-600 border-violet-600 text-white hover:bg-violet-700 hover:border-violet-700'
			: 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600 hover:border-violet-500 dark:hover:border-violet-400'}
		{disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
		focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900"
	onclick={toggle}
	onkeydown={onKey}
>
	{#if indeterminate}
		<Icon name="lucide:minus" class={iconDim} />
	{:else if checked}
		<Icon name="lucide:check" class={iconDim} />
	{/if}
</button>
