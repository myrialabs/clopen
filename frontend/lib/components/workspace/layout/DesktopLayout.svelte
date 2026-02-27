<script lang="ts">
	import { workspaceState } from '$frontend/lib/stores/ui/workspace.svelte';
	import DesktopNavigator from '../DesktopNavigator.svelte';
	import Layout from './split-pane/Layout.svelte';
</script>

<div class="flex h-full w-full">
	<!-- Desktop Navigator -->
	<DesktopNavigator />

	<!-- Main Workspace with Split Pane Layout -->
	<main id="workspace-main" class="flex-1 h-full min-w-0 relative overflow-hidden p-3 box-border">
		<Layout node={workspaceState.layout} />
	</main>
</div>
