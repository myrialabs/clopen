<script lang="ts">
	import type { SelectProps } from '$shared/types/ui/components';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	let {
		value = $bindable(''),
		placeholder = 'Select an option...',
		disabled = false,
		error = '',
		label = '',
		required = false,
		options = [],
		onchange,
		class: className = '',
		...props
	}: SelectProps & { class?: string } = $props();

	// Generate unique ID for select
	const selectId = `select-${Math.random().toString(36).substr(2, 9)}`;

	// Generate modern AI select classes
	const baseClasses =
		'block w-full px-3 py-3 pr-10 border border-slate-300 dark:border-slate-600 rounded-lg transition-colors duration-200 focus:outline-none text-sm font-medium appearance-none cursor-pointer';

	const stateClasses = error
		? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-200 dark:focus:ring-red-900/20'
		: 'focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900/20';

	const backgroundClasses =
		'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100';

	const disabledClasses = disabled 
		? 'cursor-not-allowed opacity-60' 
		: '';

	const selectClasses = `${baseClasses} ${stateClasses} ${backgroundClasses} ${disabledClasses} ${className}`;

	function handleChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		value = target.value;
		if (onchange) {
			onchange(value);
		}
	}
</script>

<div class="space-y-1">
	{#if label}
		<label for={selectId} class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
			{label}
			{#if required}
				<span class="text-red-500 ml-1">*</span>
			{/if}
		</label>
	{/if}

	<div class="relative">
		<select
			id={selectId}
			{value}
			{disabled}
			{required}
			class={selectClasses}
			onchange={handleChange}
			{...props}
		>
			{#if placeholder && !value}
				<option value="" disabled class="text-slate-400 dark:text-slate-500">
					{placeholder}
				</option>
			{/if}
			{#each options as option}
				<option 
					value={option.value} 
					disabled={option.disabled}
					class="text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
				>
					{option.label}
				</option>
			{/each}
		</select>
		
		<!-- Custom dropdown arrow -->
		<div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
			<Icon 
				name="lucide:chevron-down" 
				class="w-5 h-5 text-slate-400 dark:text-slate-500" 
			/>
		</div>
	</div>

	{#if error}
		<p class="text-sm text-red-600 dark:text-red-400 flex items-center mt-1 font-medium">
			<Icon name="lucide:circle-alert" class="w-4 h-4 mr-1" />
			{error}
		</p>
	{/if}
</div>