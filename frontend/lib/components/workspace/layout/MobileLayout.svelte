<script lang="ts">
	import { workspaceState } from '$frontend/lib/stores/ui/workspace.svelte';
	import PanelContainer from '../PanelContainer.svelte';
	import MobileNavigator from '../MobileNavigator.svelte';

	const activePanelId = $derived(workspaceState.activeMobilePanel);
</script>

<div class="flex flex-col h-full w-full">
	<MobileNavigator />

	<main id="main-content" class="flex-1 overflow-hidden">
		{#if activePanelId}
			<PanelContainer panelId={activePanelId} />
		{/if}
	</main>
</div>
