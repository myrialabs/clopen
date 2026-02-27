<script lang="ts">
	const {
		size = 'md',
		color = 'primary',
		text = '',
		class: className = '',
		...props
	}: {
		size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
		color?: '' | 'primary' | 'secondary' | 'neutral' | 'white';
		text?: string;
		class?: string;
	} = $props();

	const sizeClasses = {
		xs: 'w-3 h-3',
		sm: 'w-4 h-4',
		md: 'w-6 h-6',
		lg: 'w-8 h-8',
		xl: 'w-12 h-12'
	};

	const colorClasses = {
		primary: 'border-violet-600',
		secondary: 'border-violet-600',
		neutral: 'border-slate-500',
		white: 'border-white'
	};

	const textSizeClasses = {
		xs: 'text-xs',
		sm: 'text-sm',
		md: 'text-base',
		lg: 'text-lg',
		xl: 'text-xl'
	};

	const spinnerClasses = `animate-spin rounded-full border-2 ${sizeClasses[size]} ${color ? colorClasses[color] : ''} border-t-transparent ${className}`;
</script>

<div class="flex flex-col items-center space-y-2" {...props}>
	<div class={spinnerClasses}></div>
	{#if text}
		<span class="text-slate-600 dark:text-slate-400 font-medium {textSizeClasses[size]}">
			{text}
		</span>
	{/if}
</div>
