<script lang="ts">
	import Terminal from './Terminal.svelte';
	import PageTemplate from '../common/PageTemplate.svelte';
	import Button from '../common/Button.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	
	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');
	
	function createNewSession() {
		terminalStore.createNewSession(undefined, hasActiveProject ? projectPath : undefined, hasActiveProject ? projectId : undefined);
	}
</script>

<PageTemplate 
	title="Terminal" 
	description="Interactive command-line interface"
>
	{#snippet actions()}
		<Button variant="primary" onclick={createNewSession} disabled={!hasActiveProject} class="rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
			<Icon name="lucide:plus" class="w-3.5 h-3.5 sm:w-4 sm:h-4 sm:mr-2" />
			<span class="hidden sm:inline">New Terminal</span>
		</Button>
	{/snippet}

	{#if hasActiveProject}
		<!-- Terminal content -->
		<div class="flex flex-col h-full">
			<div class="flex-1 min-h-0">
				<Terminal />
			</div>
		</div>
	{:else}
		<!-- No Active Project Warning -->
		<div class="flex-1 min-h-0 h-96 sm:h-128 lg:h-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
			<div class="h-full flex items-center justify-center">
				<div class="text-center p-12">
					<div class="bg-amber-100 dark:bg-amber-900/30 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
						<Icon name="lucide:triangle-alert" class="w-10 h-10 text-amber-600 dark:text-amber-400" />
					</div>
					<h3 class="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">
						No Active Project
					</h3>
					<p class="text-sm text-slate-600 dark:text-slate-400 font-medium">
						Select a project from the sidebar to use the terminal
					</p>
				</div>
			</div>
		</div>
	{/if}
</PageTemplate>