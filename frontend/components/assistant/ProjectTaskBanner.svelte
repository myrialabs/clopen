<script lang="ts">
	/**
	 * "Clopen is working here" — shown above a project's workspace while a task
	 * drives one of its chats, so nobody edits the same files as the agent
	 * without knowing it. One click opens the task.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { projectState, setCurrentProject } from '$frontend/stores/core/projects.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { openTask } from '$frontend/stores/ui/assistant-view.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';

	interface Props {
		compact?: boolean;
	}

	const { compact = false }: Props = $props();

	let tasks = $state<Array<{ id: string; title: string; status: string }>>([]);

	async function load(projectId: string) {
		tasks = (await assistantStore.projectTasks(projectId)).tasks;
	}

	/** Tasks live on Clopen's screen: go there, with this one open. */
	function openTaskInClopen(id: string) {
		openTask(id);
		const home = projectState.projects.find(isAssistantProject);
		if (home) void setCurrentProject(home);
	}

	$effect(() => {
		const projectId = projectState.currentProject?.id;
		if (!projectId) {
			tasks = [];
			return;
		}
		void load(projectId);
		return ws.on('assistant:changed', (data: { scope: string }) => {
			if (data.scope === 'tasks') void load(projectId);
		});
	});
</script>

{#if tasks.length > 0}
	{@const task = tasks[0]}
	<button
		type="button"
		class="flex items-center gap-2.5 w-full shrink-0 text-left border border-violet-500/25 bg-violet-500/10 text-violet-800 dark:text-violet-200 cursor-pointer hover:bg-violet-500/15 transition-colors {compact ? 'px-3 py-1.5 text-xs' : 'px-3.5 py-2 rounded-xl text-sm'}"
		onclick={() => openTaskInClopen(task.id)}
	>
		<span class="w-2 h-2 rounded-full bg-violet-500 animate-pulse shrink-0"></span>
		<span class="flex-1 min-w-0 truncate">
			<span class="font-semibold">Clopen is working here</span> · {task.title}{tasks.length > 1 ? ` (+${tasks.length - 1})` : ''}{task.status === 'stalled' ? ' · stuck' : task.status === 'paused' ? ' · paused' : ''}
		</span>
		<span class="flex items-center gap-1 shrink-0 font-medium">View <Icon name="lucide:chevron-right" class="w-3.5 h-3.5" /></span>
	</button>
{/if}
