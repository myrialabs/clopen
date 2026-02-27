<!--
  Standard Page Template Component
  
  Provides consistent layout structure for all pages:
  - Standardized header with title and description
  - Optional actions slot
  - Consistent container width (max-w-7xl)
  - Responsive design
  - Modern AI-first flat design styling
-->

<script lang="ts">
	import { onMount } from 'svelte';
	import { setPageInfo } from '$frontend/lib/stores/core/app.svelte';

	interface Props {
		title: string;
		description?: string;
		class?: string;
		children?: import('svelte').Snippet;
		actions?: import('svelte').Snippet;
		scrollContainer?: HTMLElement | undefined;
	}

	let { title, description, class: className = '', children, actions, scrollContainer = $bindable() }: Props = $props();
	
	let scrollElement: HTMLElement;

	// Update page info when component mounts or title/description changes
	onMount(() => {
		setPageInfo(title, description, actions);
	});

	// Update page info when props change
	$effect(() => {
		setPageInfo(title, description, actions);
	});

	// Update scroll container binding
	$effect(() => {
		scrollContainer = scrollElement;
	});
</script>

<div class="h-full flex flex-col {className} relative">
	<!-- Header - Floating with blur effect -->
	<div class="hidden lg:block absolute top-0 left-0 right-0 z-10 backdrop-blur-md border-b border-slate-200 dark:border-slate-700">
		<div class="max-w-7xl mx-auto py-4 px-6">
			<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-x-6 gap-y-3">
				<div class="min-w-0">
					<h1 class="text-lg lg:text-xl font-bold text-slate-900 dark:text-slate-100 truncate">
						{title}
					</h1>
					<!-- {#if description}
						<p class="text-sm text-slate-600 dark:text-slate-400 font-medium truncate">{description}</p>
					{/if} -->
				</div>

				{#if actions}
					<div class="flex items-center gap-2 shrink-0 h-0">
						{@render actions()}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Content -->
	<div bind:this={scrollElement} class="grid h-full overflow-auto">
		<div class="w-full h-full max-w-7xl mx-auto p-6 lg:pt-20">
			{#if children}
				{@render children()}
			{/if}
		</div>
	</div>
</div>