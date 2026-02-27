<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Canvas from './Canvas.svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onDestroy } from 'svelte';
	import { getViewportDimensions, type DeviceSize, type Rotation } from '$frontend/lib/constants/preview';
	import { debug } from '$shared/utils/logger';
	import { sendScaleUpdate } from '../core/interactions.svelte';

	let {
		projectId = '', // REQUIRED for project isolation (read-only from parent)
		url = $bindable(''),
		isLoading = $bindable(false),
		isLaunchingBrowser = $bindable(false),
		isNavigating = $bindable(false),
		isReconnecting = $bindable(false), // True during fast reconnect after navigation
		deviceSize = $bindable<DeviceSize>('laptop'),
		rotation = $bindable<Rotation>('portrait'),
		sessionId = $bindable<string | null>(null),
		sessionInfo = $bindable<any>(null),
		isConnected = $bindable(false),
		isStreamReady = $bindable(false), // True when first frame received from WebCodecs
		errorMessage = $bindable<string | null>(null),
		virtualCursor = $bindable<{ x: number; y: number; visible: boolean; clicking?: boolean }>({
			x: 0,
			y: 0,
			visible: false
		}),
		lastFrameData = $bindable<any>(null), // Add lastFrameData prop

		// MCP Control State
		isMcpControlled = $bindable(false),

		// Canvas API
		canvasAPI = $bindable<any>(null),

		// Preview dimensions (bindable to parent)
		previewDimensions = $bindable<any>({ scale: 1 }),

		// Callbacks
		onInteraction = $bindable<(action: any) => void>(() => {}),
		onRetry = $bindable<() => void>(() => {})
	} = $props();

	let previewContainer = $state<HTMLDivElement | undefined>();

	// Solid loading overlay: shown during initial load states
	const showSolidOverlay = $derived(
		isLaunchingBrowser || !sessionInfo || (!isStreamReady && !isNavigating && !isReconnecting)
	);

	// Navigation overlay state with debounce to prevent flickering during state transitions
	let showNavigationOverlay = $state(false);
	let overlayHideTimeout: ReturnType<typeof setTimeout> | null = null;

	// Debounced navigation overlay - similar to progress bar logic
	// Shows immediately when navigating/reconnecting, hides with delay to prevent flicker
	$effect(() => {
		const shouldShowOverlay = (isNavigating || isReconnecting) && isStreamReady;

		// Cancel any pending hide when overlay should show
		if (shouldShowOverlay && overlayHideTimeout) {
			clearTimeout(overlayHideTimeout);
			overlayHideTimeout = null;
		}

		// Show immediately
		if (shouldShowOverlay && !showNavigationOverlay) {
			showNavigationOverlay = true;
		}
		// Hide with debounce to handle state transitions
		else if (!shouldShowOverlay && showNavigationOverlay && !overlayHideTimeout) {
			overlayHideTimeout = setTimeout(() => {
				overlayHideTimeout = null;
				// Re-check if we should still hide
				const stillShouldHide = !(isNavigating || isReconnecting) || !isStreamReady;
				if (stillShouldHide) {
					showNavigationOverlay = false;
				}
			}, 100); // 100ms debounce
		}
	});

	onDestroy(() => {
		if (overlayHideTimeout) {
			clearTimeout(overlayHideTimeout);
		}
	});

	// Use imported device viewports from config

	// Calculate and update preview dimensions
	function calculatePreviewDimensions() {
		if (!previewContainer) {
			previewDimensions = {
				width: '100%',
				height: '100%',
				scale: 1,
				frameWidth: '120rem',
				frameHeight: '67.5rem',
				containerWidth: '100%',
				containerHeight: '100%'
			};
			return;
		}

		const containerRect = previewContainer.getBoundingClientRect();
		const availableWidth = containerRect.width * 1.2;
		const availableHeight = containerRect.height * 1.2;

		// Use getViewportDimensions for consistent viewport calculation
		// This ensures portrait = height > width, landscape = width > height
		const { width: deviceWidth, height: deviceHeight } = getViewportDimensions(deviceSize as DeviceSize, rotation as Rotation);

		// Calculate scale to fit in container while maintaining aspect ratio
		// Important: Never scale up beyond original size (scale max = 1)
		const scaleX = Math.min(1, availableWidth / deviceWidth);
		const scaleY = Math.min(1, availableHeight / deviceHeight);
		const scale = Math.min(scaleX, scaleY);

		// Calculate container dimensions (what user sees)
		const containerWidth = deviceWidth * scale;
		const containerHeight = deviceHeight * scale;

		previewDimensions = {
			width: `${containerWidth / 16}rem`,
			height: `${containerHeight / 16}rem`,
			scale: scale,
			frameWidth: `${deviceWidth / 16}rem`,
			frameHeight: `${deviceHeight / 16}rem`,
			containerWidth: `${containerWidth / 16}rem`,
			containerHeight: `${containerHeight / 16}rem`
		};
	}

	// Handle canvas interactions
	function handleCanvasInteraction(action: any) {
		// Block user interactions when MCP is controlling
		if (isMcpControlled) {
			debug.log('preview', '🚫 User interaction blocked - MCP is controlling');
			return;
		}
		onInteraction(action);
	}

	function handleCursorUpdate(cursor: string) {
		// Handle cursor updates if needed
	}

	function handleFrameUpdate(data: any) {
		// Handle frame updates if needed
	}

	// Handle retry button click
	function handleRetryClick() {
		// Clear error message immediately for instant UI feedback
		errorMessage = null;
		// Call parent retry handler
		onRetry();
	}

	// Handle screencast refresh request from Canvas (when stream is stuck)
	// This sends a scale-update which triggers CDP screencast restart on backend
	function handleScreencastRefresh() {
		if (previewDimensions?.scale) {
			debug.log('preview', `📐 Requesting screencast refresh with scale: ${previewDimensions.scale}`);
			sendScaleUpdate(previewDimensions.scale);
		}
	}

	// Initial dimensions calculation
	$effect(() => {
		if (previewContainer) {
			debug.log('preview', `📐 PreviewContainer: Initial calculation`);
			calculatePreviewDimensions();
		}
	});

	// Recalculate dimensions when device size or rotation changes
	$effect(() => {
		if (previewContainer) {
			// Trigger reactive recalculation by accessing reactive values
			void deviceSize;
			void rotation;
			debug.log(
				'preview',
				`📐 PreviewContainer: Recalculating dimensions for ${deviceSize}/${rotation}`
			);
			// Force reflow for accurate container dimensions
			setTimeout(() => {
				if (previewContainer) {
					calculatePreviewDimensions();
					debug.log(
						'preview',
						`📐 PreviewContainer: New dimensions calculated - scale: ${previewDimensions.scale}`
					);
				}
			}, 50); // Small delay to ensure layout is updated
		}
	});

	// Force recalculation when sessionId changes (tab switch)
	$effect(() => {
		if (previewContainer && sessionId) {
			debug.log(
				'preview',
				`📐 PreviewContainer: SessionId changed to ${sessionId}, forcing recalculation`
			);
			setTimeout(() => {
				if (previewContainer) {
					calculatePreviewDimensions();
					debug.log(
						'preview',
						`📐 PreviewContainer: Forced calculation done - scale: ${previewDimensions.scale}`
					);
				}
			}, 100); // Slightly longer delay to ensure all state is synced
		}
	});

	// Also force recalculation when URL changes (navigation within tab)
	$effect(() => {
		if (previewContainer && url) {
			debug.log(
				'preview',
				`📐 PreviewContainer: URL changed to ${url}, checking if recalculation needed`
			);
			// Only recalculate if this might affect dimensions (shouldn't usually, but just in case)
			setTimeout(() => {
				if (previewContainer) {
					calculatePreviewDimensions();
					debug.log(
						'preview',
						`📐 PreviewContainer: URL-triggered calculation done - scale: ${previewDimensions.scale}`
					);
				}
			}, 150);
		}
	});

	// Track previous isNavigating state for navigation completion detection
	let wasNavigating = $state(false);

	// Detect navigation completion and notify Canvas for fast screencast refresh
	$effect(() => {
		// Navigation completed when isNavigating goes from true to false
		if (wasNavigating && !isNavigating && sessionId && canvasAPI?.notifyNavigationComplete) {
			debug.log('preview', `🧭 Navigation completed, notifying Canvas for fast refresh`);
			canvasAPI.notifyNavigationComplete();
		}
		wasNavigating = isNavigating;
	});

	// Recalculate on window resize
	$effect(() => {
		if (typeof window !== 'undefined') {
			const handleResize = () => {
				if (previewContainer) {
					calculatePreviewDimensions();
				}
			};
			window.addEventListener('resize', handleResize);
			return () => window.removeEventListener('resize', handleResize);
		}
	});

	// Use ResizeObserver for precise container size tracking
	$effect(() => {
		if (previewContainer && typeof window !== 'undefined' && 'ResizeObserver' in window) {
			let resizeTimeout: ReturnType<typeof setTimeout> | undefined;

			const resizeObserver = new ResizeObserver((entries) => {
				// Clear previous timeout to debounce rapid resize events
				if (resizeTimeout) {
					clearTimeout(resizeTimeout);
				}

				// Debounce resize events to prevent excessive canvas redraws
				resizeTimeout = setTimeout(() => {
					for (const entry of entries) {
						const previousDimensions = { ...previewDimensions };
						calculatePreviewDimensions();

						// Only trigger canvas setup if dimensions actually changed
						const dimensionsChanged =
							JSON.stringify(previousDimensions) !== JSON.stringify(previewDimensions);

						if (dimensionsChanged && canvasAPI && canvasAPI.setupCanvas) {
							canvasAPI.setupCanvas();
						}
					}
				}, 16); // ~60fps debouncing
			});

			resizeObserver.observe(previewContainer);

			return () => {
				if (resizeTimeout) {
					clearTimeout(resizeTimeout);
				}
				resizeObserver.disconnect();
			};
		}
	});
</script>

<!-- Preview Container with scaling -->
<div
	bind:this={previewContainer}
	class="flex-1 relative overflow-hidden p-0.5 flex items-center justify-center min-h-0"
>
	{#if errorMessage && !isLaunchingBrowser && !isLoading}
		<!-- Error State - Outside viewport container like empty state -->
		<!-- Only show error if NOT in any loading state (loading states have priority) -->
		<div
			class="text-center text-slate-500 absolute"
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<Icon name="lucide:circle-alert" class="w-16 h-16 mx-auto mb-4 text-red-500 opacity-80" />
			<p class="text-lg font-medium mb-2 text-slate-700 dark:text-slate-300">Failed to Load Page</p>
			<p class="text-sm mb-4 text-slate-600 dark:text-slate-400 max-w-md">
				{errorMessage}
			</p>
			<button
				onclick={handleRetryClick}
				class="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition-colors duration-200 inline-flex items-center gap-2"
			>
				<Icon name="lucide:refresh-cw" class="w-4 h-4" />
				<span>Try Again</span>
			</button>
		</div>
	{:else if url}
		<!-- Scaled container for proper viewport simulation -->
		<div
			class="relative rounded overflow-hidden flex-shrink-0 {isMcpControlled ? 'ring-2 ring-amber-500 ring-offset-2 ring-offset-slate-900' : ''}"
			class:mcp-control-border={isMcpControlled}
			style="width: {previewDimensions.width}; height: {previewDimensions.height};"
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<!-- Canvas container - always render when session exists so WebCodecs can start -->
			{#if sessionInfo}
				<div
					class="w-full h-full flex items-center justify-center"
					style="
						width: {previewDimensions.frameWidth};
						height: {previewDimensions.frameHeight};
						transform: scale({previewDimensions.scale});
						transform-origin: top left;
						transition: none;
					"
				>
					<Canvas
						projectId={projectId}
						bind:sessionId
						bind:sessionInfo
						bind:deviceSize
						bind:rotation
						bind:canvasAPI
						bind:lastFrameData
						bind:isConnected
						bind:isStreamReady
						bind:isNavigating
						bind:isReconnecting
						onInteraction={handleCanvasInteraction}
						onCursorUpdate={handleCursorUpdate}
						onFrameUpdate={handleFrameUpdate}
						onRequestScreencastRefresh={handleScreencastRefresh}
					/>
				</div>
			{/if}

			<!-- Solid Loading Overlay: Initial load states (launching, no session, waiting for first frame) -->
			{#if showSolidOverlay}
				<div
					class="absolute inset-0 bg-white dark:bg-slate-800 flex items-center justify-center z-10"
				>
					<div class="flex flex-col items-center gap-2">
						<Icon name="lucide:loader-circle" class="w-8 h-8 animate-spin text-violet-600" />
						<div class="text-slate-500 text-center">
							<div class="text-sm">Loading preview...</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- Navigation Overlay: Semi-transparent overlay during navigation/reconnect (shows last frame behind) -->
			{#if showNavigationOverlay}
				<div
					class="absolute inset-0 bg-white/60 dark:bg-slate-800/60 backdrop-blur-[2px] flex items-center justify-center z-10"
				>
					<div class="flex flex-col items-center gap-2">
						<Icon name="lucide:loader-circle" class="w-8 h-8 animate-spin text-violet-600" />
						<div class="text-slate-600 dark:text-slate-300 text-center">
							<div class="text-sm font-medium">Loading preview...</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- MCP Control Overlay - blocks user interaction -->
			{#if isMcpControlled && isStreamReady}
				<div
					class="absolute inset-0 z-20 pointer-events-auto cursor-not-allowed"
					role="presentation"
					aria-hidden="true"
					style="background: transparent;"
					onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onmousedown={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onmousemove={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onkeydown={(e) => { e.preventDefault(); e.stopPropagation(); }}
				>
					<!-- MCP Control Badge at top -->
					<!-- <div class="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-500/90 text-black text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg">
						<Icon name="lucide:bot" class="w-3.5 h-3.5" />
						<span>MCP Controlling</span>
					</div> -->
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="text-center text-slate-500 absolute"
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<Icon name="lucide:monitor" class="w-16 h-16 mx-auto mb-4 opacity-20" />
			<p class="text-lg font-medium mb-2">Real Browser Preview</p>
			<p class="text-sm">Enter a URL to preview your web application</p>
		</div>
	{/if}
</div>

<style>
	/* MCP Control Border Animation */
	.mcp-control-border {
		animation: mcp-border-pulse 2s ease-in-out infinite;
	}

	@keyframes mcp-border-pulse {
		0%, 100% {
			box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.5), 0 0 20px rgba(245, 158, 11, 0.3);
		}
		50% {
			box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.8), 0 0 30px rgba(245, 158, 11, 0.5);
		}
	}
</style>
