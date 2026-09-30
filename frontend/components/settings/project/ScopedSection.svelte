<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { projectArtifactsStore } from '$frontend/stores/features/project-artifacts.svelte';

	interface Props {
		title: string;
		description: string;
		global: Snippet;
		project: Snippet<[string]>;
	}

	const { title, description, global, project }: Props = $props();

	const currentProject = $derived(projectState.currentProject);
	const scope = $derived(currentProject ? projectArtifactsStore.scope : 'global');

	const tabClass = (active: boolean) =>
		`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
			active ? 'bg-white dark:bg-slate-900 text-violet-600 dark:text-violet-400 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
		}`;
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">{title}</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">{description}</p>
		</div>
		<div class="inline-flex shrink-0 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700" role="tablist" aria-label="Scope">
			<button type="button" role="tab" aria-selected={scope === 'global'} onclick={() => (projectArtifactsStore.scope = 'global')} class={tabClass(scope === 'global')}>
				<Icon name="lucide:globe" class="w-3.5 h-3.5" />
				Global
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={scope === 'project'}
				disabled={!currentProject}
				onclick={() => (projectArtifactsStore.scope = 'project')}
				title={currentProject ? currentProject.path : 'Open a project first'}
				class={tabClass(scope === 'project')}
			>
				<Icon name="lucide:folder-git-2" class="w-3.5 h-3.5" />
				<span class="max-w-40 truncate">{currentProject ? currentProject.name : 'Project'}</span>
			</button>
		</div>
	</div>

	{#if scope === 'project' && currentProject}
		{@render project(currentProject.id)}
	{:else}
		{@render global()}
	{/if}
</div>
