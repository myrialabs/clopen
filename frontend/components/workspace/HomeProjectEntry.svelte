<script lang="ts">
	/**
	 * Home: the user's own workspace for chatting with no project selected.
	 *
	 * Rendered on its own above the project list rather than inside it: Home is
	 * not a project among projects, so it is never sorted, pinned, archived,
	 * selected for bulk actions or deleted with them. It sits in the list's
	 * own row style, set apart by its mark and a divider below it.
	 */
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { isHomeProject } from '$shared/utils/home-project';
	import type { Project } from '$shared/types/database/schema';
	import HomeMark from './HomeMark.svelte';

	interface Props {
		/** The narrow icon-only navigator. */
		collapsed?: boolean;
		onSelect: (project: Project) => void;
	}

	const { collapsed = false, onSelect }: Props = $props();

	const home = $derived(projectState.projects.find(isHomeProject) ?? null);
	const isCurrent = $derived(Boolean(home) && projectState.currentProject?.id === home?.id);
</script>

{#if home}
	{#if collapsed}
		<button
			type="button"
			class="flex items-center justify-center w-9 h-9 shrink-0 rounded-lg cursor-pointer transition-all duration-150
				{isCurrent ? 'bg-violet-500/15 dark:bg-violet-500/20' : 'hover:bg-violet-500/10'}"
			onclick={() => onSelect(home)}
			title="Home: chat without a project"
			aria-label="Home: chat without a project"
		>
			<HomeMark class="w-6.5 h-6.5 rounded-md" muted={!isCurrent} />
		</button>
	{:else}
		<div class="pb-2 mb-1 border-b border-slate-200/70 dark:border-slate-800">
			<button
				type="button"
				class="flex items-center gap-2.5 w-full py-2 px-3 rounded-lg text-left text-sm cursor-pointer transition-all duration-150
					{isCurrent
					? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100'
					: 'text-slate-700 dark:text-slate-300 hover:bg-violet-500/10'}"
				onclick={() => onSelect(home)}
				title="Chat with Clopen without picking a project"
				aria-current={isCurrent ? 'page' : undefined}
			>
				<HomeMark class="w-6 h-6 rounded-md" muted={!isCurrent} />
				<span class="flex-1 min-w-0 font-semibold truncate">Home</span>
				<span class="shrink-0 text-xs text-slate-400 dark:text-slate-500">No project</span>
			</button>
		</div>
	{/if}
{/if}
