<script lang="ts">
	import BrowserPreview from '$frontend/lib/components/preview/browser/BrowserPreview.svelte';
	import { mcpPreviewState, clearMCPLaunchRequest } from '$frontend/lib/services/preview';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { debug } from '$shared/utils/logger';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { DeviceSize, Rotation } from '$frontend/lib/constants/preview';

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectId = $derived(projectState.currentProject?.id || '');

	// Store per-project preview state
	const projectPreviewState = new Map<string, {
		isOpen: boolean;
		url: string;
		mode: 'split' | 'tab';
		deviceSize: DeviceSize;
		rotation: Rotation;
	}>();

	let lastProjectId = $state<string>('');

	// Preview state (will be restored per project)
	let isOpen = $state(true);
	let url = $state('');
	let mode = $state<'split' | 'tab'>('split');

	// Device and viewport state (exposed to parent for header controls)
	let deviceSize = $state<DeviceSize>('laptop');
	let rotation = $state<Rotation>('portrait');
	let previewDimensions = $state<any>({ scale: 1 });

	// BrowserPreview reference
	let browserPreviewRef: any = $state();

	// Watch for MCP launch requests and trigger browser launch (only for current project)
	$effect(() => {
		if (hasActiveProject && mcpPreviewState.pendingLaunch) {
			const request = mcpPreviewState.pendingLaunch;

			debug.log('mcp', `🚀 Launching browser from MCP request`);
			debug.log('mcp', `   URL: ${request.url}`);
			debug.log('mcp', `   Device: ${request.deviceSize} (${request.rotation})`);

			// Update URL - this will trigger BrowserPreview's URL watcher to launch browser
			url = request.url;
			isOpen = true;

			// Clear the pending launch (but keep it for a moment to allow BrowserPreview to react)
			setTimeout(() => {
				clearMCPLaunchRequest();
			}, 100);

			debug.log('mcp', `✅ Browser launch triggered from MCP`);
		}
	});

	// Save and restore preview state when project changes
	$effect(() => {
		if (hasActiveProject && projectId) {
			// Save current project state before switching
			if (lastProjectId && lastProjectId !== projectId) {
				projectPreviewState.set(lastProjectId, {
					isOpen,
					url,
					mode,
					deviceSize,
					rotation
				});
				debug.log('preview', `Saved preview state for project: ${lastProjectId}`);
			}

			// Restore previous state for this project
			const savedState = projectPreviewState.get(projectId);
			if (savedState) {
				isOpen = savedState.isOpen;
				url = savedState.url;
				mode = savedState.mode;
				deviceSize = savedState.deviceSize;
				rotation = savedState.rotation;
				debug.log('preview', `Restored preview state for project: ${projectId}`);
			} else {
				// Reset state for new project
				isOpen = true;
				url = '';
				mode = 'split';
				deviceSize = 'laptop';
				rotation = 'portrait';
				debug.log('preview', `Reset preview state for new project: ${projectId}`);
			}

			lastProjectId = projectId;
		} else {
			// No active project - reset everything
			isOpen = true;
			url = '';
			mode = 'split';
			deviceSize = 'laptop';
			rotation = 'portrait';
			lastProjectId = '';
		}
	});

	// Export actions for DesktopPanel header
	export const panelActions = {
		getDeviceSize: () => deviceSize,
		getRotation: () => rotation,
		getScale: () => previewDimensions?.scale || 1,
		getUrl: () => url,
		getSessionInfo: () => browserPreviewRef?.browserActions?.getSessionInfo() || null,
		getIsStreamReady: () => browserPreviewRef?.browserActions?.getIsStreamReady() || false,
		getErrorMessage: () => browserPreviewRef?.browserActions?.getErrorMessage() || null,
		setDeviceSize: (size: DeviceSize) => {
			if (browserPreviewRef?.browserActions) {
				browserPreviewRef.browserActions.changeDeviceSize(size);
			}
		},
		toggleRotation: () => {
			if (browserPreviewRef?.browserActions) {
				browserPreviewRef.browserActions.toggleRotation();
			}
		}
	};
</script>

<div class="h-full flex flex-col bg-transparent">
	{#if !hasActiveProject}
		<!-- No project selected state -->
		<div
			class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm"
		>
			<Icon name="lucide:globe" class="w-10 h-10 opacity-30" />
			<span>No project selected</span>
		</div>
	{:else}
		<!-- Full WebPreview -->
		<div class="h-full overflow-hidden">
			<BrowserPreview
				bind:this={browserPreviewRef}
				bind:url
				bind:isOpen
				bind:mode
				bind:deviceSize
				bind:rotation
				bind:previewDimensions
			/>
		</div>
	{/if}
</div>
