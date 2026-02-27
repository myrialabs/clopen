<script lang="ts">
	import { onMount } from 'svelte';
	import WorkspaceLayout from '$frontend/lib/components/workspace/WorkspaceLayout.svelte';
	import { backgroundTerminalService } from '$frontend/lib/services/terminal/background';
	import { initializeMCPPreview } from '$frontend/lib/services/preview';
	import { globalStreamMonitor } from '$frontend/lib/services/notification/global-stream-monitor';

	// NOTE: In Phase 3, we'll need to handle routing for SPA
	// For now, we'll just render the main workspace

	// Initialize background terminal service and MCP preview integration
	onMount(async () => {
		// Initialize global stream monitor FIRST (just registers a WS listener, non-blocking)
		// Must run before any await to ensure cross-project notifications work immediately
		globalStreamMonitor.initialize();

		// Initialize background service first and wait for it
		await backgroundTerminalService.initialize();

		// Now background service has restored any persisted sessions
		// The terminal store will check this when initializing

		// Initialize MCP Preview Integration
		// This sets up listeners for MCP browser automation events
		initializeMCPPreview();
	});
</script>

<WorkspaceLayout>
	{#snippet children()}
		<!-- Main content will be here -->
		<!-- TODO: Add SPA router in Phase 3 if needed -->
	{/snippet}
</WorkspaceLayout>
