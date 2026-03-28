<script lang="ts">
	import { appState } from '$frontend/stores/core/app.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fly } from 'svelte/transition';

	interface Props {
		visibleLoadingText: string;
		isWelcomeState: boolean;
	}

	const { visibleLoadingText, isWelcomeState }: Props = $props();
</script>

{#if appState.isLoading}
	<div
		class="absolute z-20 h-9 {isWelcomeState ? '-top-16' : '-top-14'} left-0 right-0 flex justify-center pointer-events-none"
		transition:fly={{ y: 100, duration: 300 }}
	>
		{#if appState.isWaitingInput}
			<!-- Waiting for user input state -->
			<div class="flex items-center gap-2.5 px-4 py-2 bg-amber-50 dark:bg-amber-950 rounded-full border border-amber-200 dark:border-amber-900 shadow-sm">
				<Icon name="lucide:message-circle-question-mark" class="w-4 h-4 text-amber-600 dark:text-amber-400" />
				<span class="text-sm font-medium text-amber-700 dark:text-amber-300">
					Waiting for your input...
				</span>
			</div>
		{:else}
			<!-- Normal loading state -->
			<div class="flex items-center gap-2.5 px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-full border border-slate-300 dark:border-slate-600 shadow-sm">
				<!-- Simple spinner -->
				<svg class="animate-spin h-4 w-4 text-slate-700 dark:text-slate-300" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>

				<!-- Text with typewriter effect -->
				<span class="text-sm font-medium text-slate-700 dark:text-slate-300 capitalize">
					{visibleLoadingText}
				</span>
			</div>
		{/if}
	</div>
{/if}
