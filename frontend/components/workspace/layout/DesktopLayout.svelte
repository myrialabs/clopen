<script lang="ts">
	import { workspaceState } from '$frontend/stores/ui/workspace.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';
	import DesktopNavigator from '../DesktopNavigator.svelte';
	import Layout from './split-pane/Layout.svelte';
	import AssistantView from '$frontend/components/assistant/AssistantView.svelte';
	import ProjectTaskBanner from '$frontend/components/assistant/ProjectTaskBanner.svelte';

	// Clopen's own chat is not a project workspace: it gets the assistant view
	// (chat, tasks, automations) instead of the split-pane panels.
	const isAssistant = $derived(isAssistantProject(projectState.currentProject));
</script>

<div class="flex h-full w-full">
	<!-- Desktop Navigator -->
	<DesktopNavigator />

	<!-- Main Workspace with Split Pane Layout -->
	<main id="workspace-main" class="flex-1 h-full min-w-0 relative overflow-hidden p-3 box-border flex flex-col gap-2">
		{#if isAssistant}
			<AssistantView />
		{:else}
			<ProjectTaskBanner />
			<div class="flex-1 min-h-0 relative">
				<Layout node={workspaceState.layout} />
			</div>
		{/if}
	</main>
</div>
