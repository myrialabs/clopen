<script lang="ts">
	import type { InputProps } from '$shared/types/ui/components';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	let {
		value = $bindable(''),
		placeholder = '',
		type = 'text',
		disabled = false,
		error = '',
		label = '',
		required = false,
		onchange,
		class: className = '',
		...props
	}: InputProps & { class?: string } = $props();

	// Generate unique ID for input
	const inputId = `input-${Math.random().toString(36).substr(2, 9)}`;

	// Generate modern AI input classes
	const baseClasses =
		'block w-full px-3 py-3 border border-slate-300 dark:border-slate-600 rounded-lg transition-colors duration-200 focus:outline-none text-sm font-medium';

	const stateClasses = error
		? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-200 dark:focus:ring-red-900/20'
		: 'focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900/20';

	const backgroundClasses =
		'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500';

	const inputClasses = `${baseClasses} ${stateClasses} ${backgroundClasses} ${className}`;

	function handleInput(event: Event) {
		const target = event.target as HTMLInputElement;
		value = target.value;
		if (onchange) {
			onchange(value);
		}
	}
</script>

<div class="space-y-1">
	{#if label}
		<label for={inputId} class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
			{label}
			{#if required}
				<span class="text-red-500 ml-1">*</span>
			{/if}
		</label>
	{/if}

	<input
		id={inputId}
		{type}
		{value}
		{placeholder}
		{disabled}
		{required}
		class={inputClasses}
		oninput={handleInput}
		autocomplete="off"
		{...props}
	/>

	{#if error}
		<p class="text-sm text-red-600 dark:text-red-400 flex items-center mt-1 font-medium">
			<Icon name="lucide:circle-alert" class="w-4 h-4 mr-1" />
			{error}
		</p>
	{/if}
</div>
