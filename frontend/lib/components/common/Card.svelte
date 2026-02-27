<script lang="ts">
	import type { CardProps } from '$shared/types/ui';

	const {
		title = '',
		subtitle = '',
		variant = 'default',
		padding = 'md',
		clickable = false,
		onclick,
		class: className = '',
		children,
		...props
	}: CardProps & { class?: string; children?: import('svelte').Snippet } = $props();

	// Generate modern AI card classes
	const baseClasses = 'rounded-lg transition-colors duration-200';

	const variantClasses = {
		default: 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700',
		outlined: 'bg-transparent border border-slate-200 dark:border-slate-700',
		elevated:
			'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700',
		glass: 'ai-card dark:ai-card-light'
	};

	const paddingClasses = {
		none: '',
		sm: 'p-2 md:p-3',
		md: 'p-3 md:p-4',
		lg: 'p-4 md:p-6'
	};

	const clickableClasses = clickable
		? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800'
		: '';

	const cardClasses = `${baseClasses} ${variantClasses[variant]} ${paddingClasses[padding]} ${clickableClasses} ${className}`;

	function handleClick() {
		if (clickable && onclick) {
			onclick();
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (clickable && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			handleClick();
		}
	}
</script>

{#if clickable}
	<button
		class={cardClasses}
		onclick={handleClick}
		onkeydown={handleKeyPress}
		aria-label="Clickable card"
		{...props}
	>
		{#if title || subtitle}
			<div class="mb-4">
				{#if title}
					<h3 class="text-lg font-bold text-slate-900 dark:text-slate-100 mb-1">
						{title}
					</h3>
				{/if}
				{#if subtitle}
					<p class="text-sm text-slate-600 dark:text-slate-400">
						{subtitle}
					</p>
				{/if}
			</div>
		{/if}

		{#if children}
			{@render children()}
		{/if}
	</button>
{:else}
	<div class={cardClasses} {...props}>
		{#if title || subtitle}
			<div class="mb-4">
				{#if title}
					<h3 class="text-lg font-bold text-slate-900 dark:text-slate-100 mb-1">
						{title}
					</h3>
				{/if}
				{#if subtitle}
					<p class="text-sm text-slate-600 dark:text-slate-400">
						{subtitle}
					</p>
				{/if}
			</div>
		{/if}

		{#if children}
			{@render children()}
		{/if}
	</div>
{/if}
