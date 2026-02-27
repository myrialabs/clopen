<script lang="ts">
	import { fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from './Icon.svelte';
	
	let { isVisible = $bindable(), progress = 0, loadingText = 'Initializing workspace...' } = $props();
</script>

{#if isVisible}
	<div 
		class="fixed inset-0 z-[9999] bg-white dark:bg-slate-950 flex items-center justify-center"
		out:fade={{ duration: 300, easing: cubicOut }}
	>
		<div class="flex flex-col items-center gap-4 text-center px-4">
			<!-- Logo and Brand -->
			<div class="relative">
				<img src="/favicon.svg" alt="Clopen" class="w-20 h-20 rounded-3xl shadow-2xl" />
				<!-- Loading animation ring -->
				<div class="absolute inset-0 rounded-3xl border-4 border-violet-600/20 animate-pulse"></div>
			</div>
			
			<!-- App Title -->
			<div class="space-y-2">
				<h1 class="text-3xl font-bold bg-gradient-to-r from-violet-600 to-violet-600 bg-clip-text text-transparent">
					Clopen
				</h1>
			</div>
			
			<!-- Loading Progress -->
			<div class="space-y-2">
				<!-- Dynamic loading text -->
				<p class="text-slate-500 dark:text-slate-500 text-sm font-medium min-h-5">
					{loadingText}
				</p>
				
				<!-- Progress bar with smooth JS animation -->
				<div class="w-72 h-1 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
					<div
						class="h-full bg-gradient-to-r from-violet-600 to-violet-600 rounded-full transition-all duration-300 ease-out"
						style="width: {progress}%"
					></div>
				</div>
				
				<!-- Progress percentage -->
				<p class="text-xs text-slate-400 dark:text-slate-600 font-mono">
					{Math.round(progress)}%
				</p>
			</div>
		</div>
	</div>
{/if}

