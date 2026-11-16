<script lang="ts">
	import { workspaceState } from '$frontend/stores/ui/workspace.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';
	import PanelContainer from '../PanelContainer.svelte';
	import MobileNavigator from '../MobileNavigator.svelte';
	import AssistantView from '$frontend/components/assistant/AssistantView.svelte';
	import ProjectTaskBanner from '$frontend/components/assistant/ProjectTaskBanner.svelte';

	const activePanelId = $derived(workspaceState.activeMobilePanel);
	const isAssistant = $derived(isAssistantProject(projectState.currentProject));
</script>

<div class="flex flex-col h-full w-full">
	<MobileNavigator />

	<main id="main-content" class="flex-1 overflow-hidden flex flex-col">
		{#if isAssistant}
			<AssistantView mobile />
		{:else}
			<ProjectTaskBanner compact />
			{#if activePanelId}
				<div class="flex-1 min-h-0">
					<PanelContainer panelId={activePanelId} />
				</div>
			{/if}
		{/if}
	</main>
</div>
