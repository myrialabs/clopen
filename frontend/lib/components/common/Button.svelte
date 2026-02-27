<script lang="ts">
	import type { ButtonProps } from '$shared/types/ui';

	const {
		variant = 'primary',
		size = 'md',
		disabled = false,
		loading = false,
		type = 'button',
		onclick,
		class: className = '',
		children,
		...props
	}: ButtonProps & { class?: string; children?: import('svelte').Snippet } = $props();

	// Generate modern AI button classes based on props
	const baseClasses =
		'inline-flex items-center justify-center font-semibold transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed';

	const variantClasses = {
		primary: 'bg-violet-600 hover:bg-violet-700 text-white',
		secondary:
			'bg-violet-600 hover:bg-violet-700 text-white',
		outline:
			'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
		ghost:
			'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
	};

	const sizeClasses = {
		sm: 'px-2.5 md:px-3 py-2 text-xs md:text-sm rounded-md',
		md: 'px-3 md:px-4 py-2.5 text-sm rounded-lg',
		lg: 'px-4 md:px-6 py-3 text-sm md:text-base rounded-lg'
	};

	const buttonClasses = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

	function handleClick() {
		if (!disabled && !loading && onclick) {
			onclick();
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick();
		}
	}
</script>

<button
	{type}
	{disabled}
	class={buttonClasses}
	onclick={handleClick}
	onkeydown={handleKeyPress}
	aria-busy={loading}
	aria-disabled={disabled}
	{...props}
>
	{#if loading}
		<div
			class="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2"
		></div>
	{/if}

	{#if children}
		{@render children()}
	{/if}
</button>
