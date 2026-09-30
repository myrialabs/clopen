<script lang="ts">
	import { untrack } from 'svelte';
	import PermissionsSettings from '$frontend/components/settings/permissions/PermissionsSettings.svelte';
	import { projectArtifactsStore } from '$frontend/stores/features/project-artifacts.svelte';

	interface Props {
		projectId: string;
	}

	const { projectId }: Props = $props();

	$effect(() => {
		const id = projectId;
		untrack(() => void projectArtifactsStore.refresh(id));
	});

	const scan = $derived(projectArtifactsStore.scanProjectId === projectId ? projectArtifactsStore.scan : null);
	const repoRules = $derived(scan?.claudePermissions ?? []);
</script>

<div class="space-y-6">
	{#key projectId}
		<PermissionsSettings showHeader={false} {projectId} />
	{/key}

	{#if repoRules.length > 0}
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">Rules in the repository</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">read-only</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">Claude Code</span>
			</div>
			{#each repoRules as file (file.path)}
				<div class="space-y-2 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
					<p class="font-semibold text-sm text-slate-900 dark:text-slate-100">{file.path}</p>
					<div class="flex flex-wrap gap-1.5">
						{#each file.deny as rule (rule)}
							<span class="px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold bg-red-500/10 text-red-600 dark:text-red-400">deny {rule}</span>
						{/each}
						{#each file.allow as rule (rule)}
							<span class="px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">allow {rule}</span>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
