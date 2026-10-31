<script lang="ts">
	import BrowserPreview from '$frontend/components/preview/browser/BrowserPreview.svelte';
	import { mcpPreviewState, clearMCPLaunchRequest } from '$frontend/services/preview';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { debug } from '$shared/utils/logger';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		isPreviewZoom,
		resolveDevicePreset,
		resolveViewport,
		type DeviceSize,
		type PreviewZoom,
		type Rotation,
		type ViewportSize
	} from '$frontend/utils/preview-constants';
	import {
		getProjectPreviewState,
		setProjectPreviewState,
		setPreviewSnapshotProvider
	} from '$frontend/utils/preview-project-state';
	import { requestWorkspaceSave } from '$frontend/stores/ui/project-workspace.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectId = $derived(projectState.currentProject?.id || '');

	let lastProjectId = $state<string>('');

	// Preview state (will be restored per project)
	let isOpen = $state(true);
	let url = $state('');
	let mode = $state<'split' | 'tab'>('split');

	// Device and viewport state (exposed to parent for header controls)
	let deviceSize = $state<DeviceSize>('laptop');
	let rotation = $state<Rotation>('portrait');
	/** The active tab's exact size, mirrored like the class and rotation above. */
	let viewport = $state<ViewportSize | null>(null);
	let deviceModel = $state<string | null>(null);
	/** View prefs, persisted per project: they describe how this user looks, not the tab. */
	let showFrame = $state(true);
	let zoom = $state<PreviewZoom>('fit');
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
			// Save current project state before switching.
			// NOTE: `url` is intentionally NOT persisted/restored here. Tabs (and
			// their URLs) are owned by the preview-tabs dock; the active tab's URL
			// flows back through onUrlChange. Restoring a URL here would feed
			// BrowserPreview's URL-watcher and spawn a duplicate tab on every
			// switch, racing the dock's recovery.
			if (lastProjectId && lastProjectId !== projectId) {
				setProjectPreviewState(lastProjectId, {
					isOpen,
					mode,
					deviceSize,
					rotation,
					showFrame,
					zoom
				});
				debug.log('preview', `Saved preview state for project: ${lastProjectId}`);
			}

			// Restore previous state for this project
			const savedState = getProjectPreviewState(projectId);
			if (savedState) {
				isOpen = savedState.isOpen;
				mode = savedState.mode;
				deviceSize = savedState.deviceSize;
				rotation = savedState.rotation;
				showFrame = savedState.showFrame ?? true;
				zoom = isPreviewZoom(savedState.zoom) ? savedState.zoom : 'fit';
				debug.log('preview', `Restored preview state for project: ${projectId}`);
			} else {
				// Reset state for new project
				isOpen = true;
				mode = 'split';
				deviceSize = 'laptop';
				rotation = 'portrait';
				showFrame = true;
				zoom = 'fit';
				debug.log('preview', `Reset preview state for new project: ${projectId}`);
			}

			lastProjectId = projectId;
		} else {
			// No active project - reset everything
			isOpen = true;
			mode = 'split';
			deviceSize = 'laptop';
			rotation = 'portrait';
			showFrame = true;
			zoom = 'fit';
			lastProjectId = '';
		}
	});

	// Expose live preview prefs to the workspace coordinator so a switch flushes
	// the leaving project's prefs to the server accurately.
	$effect(() => {
		setPreviewSnapshotProvider(() => ({ isOpen, mode, deviceSize, rotation, showFrame, zoom }));
		return () => setPreviewSnapshotProvider(null);
	});

	// Persist in-place pref changes (device/rotation/url/mode) to the server,
	// debounced. Skipped during a project switch (those are restores, not edits).
	$effect(() => {
		// Track the persisted fields.
		void isOpen;
		void url;
		void mode;
		void deviceSize;
		void rotation;
		void showFrame;
		void zoom;
		if (!hasActiveProject || appState.isSwitching) return;
		requestWorkspaceSave();
	});

	// Export actions for DesktopPanel header
	export const panelActions = {
		getTouchMode: () => browserPreviewRef?.browserActions?.getTouchMode() || 'scroll',
		setTouchMode: (mode: 'scroll' | 'cursor') => { browserPreviewRef?.browserActions?.setTouchMode(mode); },
		getDeviceSize: () => deviceSize,
		getRotation: () => rotation,
		getViewport: (): ViewportSize => resolveViewport(deviceSize, rotation, viewport),
		/** The model shown — the class default when the tab names none. */
		getDeviceModel: () => resolveDevicePreset(deviceSize, deviceModel)?.id ?? null,
		getShowFrame: () => showFrame,
		setShowFrame: (value: boolean) => {
			showFrame = value;
		},
		getZoom: () => zoom,
		setZoom: (value: PreviewZoom) => {
			zoom = value;
		},
		getScale: () => previewDimensions?.scale || 1,
		getUrl: () => url,
		getSessionInfo: () => browserPreviewRef?.browserActions?.getSessionInfo() || null,
		getIsStreamReady: () => browserPreviewRef?.browserActions?.getIsStreamReady() || false,
		getErrorMessage: () => browserPreviewRef?.browserActions?.getErrorMessage() || null,
		getIsMcpControlled: () => browserPreviewRef?.browserActions?.getIsMcpControlled() || false,
		setDeviceSize: (size: DeviceSize) => {
			if (browserPreviewRef?.browserActions) {
				browserPreviewRef.browserActions.changeDeviceSize(size);
			}
		},
		setViewportSize: (size: DeviceSize, value: ViewportSize) => {
			browserPreviewRef?.browserActions?.setViewportSize(size, value);
		},
		selectDeviceModel: (size: DeviceSize, model: string) => {
			browserPreviewRef?.browserActions?.selectDeviceModel(size, model);
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
				bind:viewport
				bind:deviceModel
				bind:showFrame
				bind:zoom
				bind:previewDimensions
			/>
		</div>
	{/if}
</div>
