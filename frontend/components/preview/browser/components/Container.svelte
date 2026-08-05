<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Canvas from './Canvas.svelte';
	import DeviceFrame from './DeviceFrame.svelte';
	import VirtualCursor from './VirtualCursor.svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onDestroy } from 'svelte';
	import {
		getViewportDimensions,
		getFrameMetrics,
		type DeviceSize,
		type Rotation
	} from '$frontend/utils/preview-constants';
	import { debug } from '$shared/utils/logger';
	import { sendScaleUpdate, setDisplayScale } from '../core/interactions.svelte';

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
		/**
		 * Whether the canvas currently has a picture on it.
		 *
		 * Distinct from `isStreamReady`, which tracks the *stream* and drops to
		 * false on every mid-session restart even though the last frame is still
		 * painted and still correct. This one only goes false when there is
		 * genuinely nothing to look at.
		 */
		hasPaintedContent = $bindable(false),
		errorMessage = $bindable<string | null>(null),
		virtualCursor = $bindable<{ x: number; y: number; visible: boolean; clicking?: boolean }>({
			x: 0,
			y: 0,
			visible: false
		}),
		/**
		 * The agent's pointer on the tab being shown, in *page* coordinates, or
		 * null when no agent has moved on it.
		 *
		 * Projected here rather than by the panel because everything the
		 * projection needs — the canvas, the fit scale, the container's own
		 * origin — lives at this level. Handing the panel screen coordinates to
		 * pass back down meant the conversion ran before the canvas had painted
		 * and the position was dropped for good.
		 *
		 * Position only. Whether the pointer is *drawn* is decided by the lock —
		 * see `mcpCursor` below.
		 */
		mcpCursorPage = null as { x: number; y: number; clicking?: boolean; pressed?: boolean } | null,

		// MCP Control State
		isMcpControlled = $bindable(false),
		/**
		 * Whether the agent is acting on *this* tab right now, as opposed to
		 * merely holding it. Only the tab being worked on pulses — with several
		 * locked at once, a border that pulses on all of them says nothing.
		 */
		isMcpFocused = false,
		/**
		 * What the agent is doing right now, from the backend. Empty while it
		 * holds the tab without acting, which reads as a bare "Agent".
		 */
		mcpActivity = '' as string,

		/**
		 * The page has something full screen.
		 *
		 * The only way out. The shim used to draw a hint inside the page as well,
		 * which meant two buttons saying the same thing over one frame — and the
		 * in-page one was the weaker of the two: a node the page can destroy on a
		 * re-render, and never drawn at all for a fullscreen Chrome granted from
		 * its own C++. This control lives outside the page, so nothing in the
		 * page can take it away.
		 */
		isPageFullscreen = false,
		onExitFullscreen = (() => {}) as () => void,

		// Canvas API
		canvasAPI = $bindable<any>(null),

		// Preview dimensions (bindable to parent)
		previewDimensions = $bindable<any>({ scale: 1 }),

		// Touch interaction mode
		touchMode = $bindable<'scroll' | 'cursor'>('scroll'),

		// Callbacks
		onInteraction = $bindable<(action: any) => void>(() => {}),
		onRetry = $bindable<() => void>(() => {})
	} = $props();

	let previewContainer = $state<HTMLDivElement | undefined>();
	let touchCursorPos = $state<{ x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean }>({ x: 0, y: 0, visible: false });

	type OverlayCursor = { x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean };

	const HIDDEN_CURSOR: OverlayCursor = { x: 0, y: 0, visible: false };

	/**
	 * Where the frame is painted, in this container's own coordinates.
	 *
	 * Measured from the DOM, but held as state, and that distinction is the
	 * whole point. Everything that positions an overlay used to call
	 * `getBoundingClientRect` from inside a `$derived` — and a rect is not a
	 * signal, so the derived only re-ran when something *else* it happened to
	 * read changed. Measure at a moment when the canvas has no geometry (mid
	 * tab-switch, panel still laying out, first frame not yet decoded) and the
	 * answer is "cannot place this", cached, with nothing to invalidate it. The
	 * pointer then stayed gone until some unrelated dependency moved, which is
	 * why it came back sometimes and, after a switch or a reload, usually not
	 * at all.
	 *
	 * Written by `measureFrame()` below, and only when the numbers actually
	 * change, so this never feeds its own observers.
	 */
	let frameGeom = $state<{ left: number; top: number; width: number; height: number } | null>(null);

	/** This container's own origin in the viewport, measured alongside the above. */
	let containerOrigin = $state<{ left: number; top: number } | null>(null);

	/**
	 * Viewport → container-local, for overlays that already know where they go
	 * on screen (the user's own cursor, the touch cursor).
	 *
	 * Reads the measured origin rather than calling `getBoundingClientRect`
	 * here, for the same reason `frameGeom` exists: a rect read inside a
	 * `$derived` is a value the derived can never be told has changed.
	 */
	function toLocalCursor(cursor: Partial<OverlayCursor> | null | undefined): OverlayCursor {
		if (!cursor?.visible || !containerOrigin) return HIDDEN_CURSOR;
		return {
			...cursor,
			visible: true,
			x: (cursor.x ?? 0) - containerOrigin.left,
			y: (cursor.y ?? 0) - containerOrigin.top
		};
	}

	/**
	 * The agent's pointer, page coordinates → where to draw it.
	 *
	 * Drawn for as long as the agent is *on* this tab, not only while cursor
	 * events are arriving. Those two are not the same thing, and the difference
	 * is most of a run: a batch of `type` actions against named selectors, a
	 * `navigate`, a `screenshot`, a long `wait_for` — none of them necessarily
	 * moves a pointer, so a tab could be worked on for a minute while the
	 * preview showed a page changing by itself with nothing on it to say why.
	 */
	const mcpCursor = $derived.by((): OverlayCursor => {
		// The lock decides, and nothing else does. An action is only
		// interruptible between steps, so pressing stop mid-gesture leaves a
		// tail of pointer updates still arriving for a tab that has already
		// been handed back; if a position could put the pointer on screen, the
		// agent would appear to keep working after being told to stop. It also
		// has to be *this* tab the agent is on: a session holds several tabs at
		// once, and drawing a pointer on the ones it is merely holding left a
		// cursor parked in the middle of a page nothing was happening to.
		if (!isMcpFocused) return HIDDEN_CURSOR;
		if (!frameGeom) return HIDDEN_CURSOR;

		// Held but never moved — park it mid-page rather than in the corner,
		// which reads as a pointer that got lost. The first real event moves it.
		const x = mcpCursorPage?.x ?? pageSize.width / 2;
		const y = mcpCursorPage?.y ?? pageSize.height / 2;

		return {
			x: frameGeom.left + x * (frameGeom.width / pageSize.width),
			y: frameGeom.top + y * (frameGeom.height / pageSize.height),
			visible: true,
			clicking: mcpCursorPage?.clicking,
			pressed: mcpCursorPage?.pressed
		};
	});

	/**
	 * The agent is working, but on a tab this viewer is not looking at.
	 *
	 * Worth saying out loud. Without it, a locked-but-not-focused tab shows a
	 * blocked overlay and an amber ring with no explanation of where the agent
	 * actually went — and the previous answer, drawing a motionless pointer in
	 * the middle of the page, was worse: it looked like the agent had frozen.
	 */
	const showAgentElsewhereHint = $derived(isMcpControlled && !isMcpFocused);

	const localVirtualCursor = $derived(toLocalCursor(virtualCursor));
	const localTouchCursor = $derived(toLocalCursor(touchCursorPos));

	/**
	 * The page's own coordinate space — the emulated viewport, in CSS pixels.
	 * Same derivation as the canvas uses; the backend dispatches page points in
	 * these units.
	 */
	const pageSize = $derived(
		getViewportDimensions(deviceSize as DeviceSize, rotation as Rotation)
	);

	/**
	 * Re-measure where the frame is painted.
	 *
	 * Cheap, idempotent, and safe to call from anywhere — it writes only when
	 * the numbers moved, so it cannot loop through the observers that call it.
	 * Sub-pixel jitter is ignored for the same reason.
	 */
	function measureFrame(): void {
		const rect = canvasAPI?.getPaintedRect?.();
		const container = previewContainer?.getBoundingClientRect();

		if (container) {
			const origin = containerOrigin;
			if (
				!origin ||
				Math.abs(origin.left - container.left) >= 0.5 ||
				Math.abs(origin.top - container.top) >= 0.5
			) {
				containerOrigin = { left: container.left, top: container.top };
			}
		} else if (containerOrigin !== null) {
			containerOrigin = null;
		}

		if (!rect || !container || rect.width === 0 || rect.height === 0) {
			if (frameGeom !== null) frameGeom = null;
			return;
		}

		const next = {
			left: rect.left - container.left,
			top: rect.top - container.top,
			width: rect.width,
			height: rect.height
		};

		const current = frameGeom;
		if (
			current &&
			Math.abs(current.left - next.left) < 0.5 &&
			Math.abs(current.top - next.top) < 0.5 &&
			Math.abs(current.width - next.width) < 0.5 &&
			Math.abs(current.height - next.height) < 0.5
		) {
			return;
		}

		frameGeom = next;
	}

	/** Measure after the browser has laid out, not during the change that caused it. */
	let measureFrameHandle: number | undefined;
	function scheduleMeasureFrame(): void {
		if (typeof requestAnimationFrame !== 'function') {
			measureFrame();
			return;
		}
		if (measureFrameHandle !== undefined) return;
		measureFrameHandle = requestAnimationFrame(() => {
			measureFrameHandle = undefined;
			measureFrame();
		});
	}

	/**
	 * Everything that can move the painted rect without resizing anything.
	 *
	 * A tab switch, a device change, a first frame, a new scale: none of these
	 * necessarily change the canvas element's box, so no ResizeObserver fires,
	 * yet where a page point lands changes anyway.
	 */
	$effect(() => {
		void sessionId;
		void deviceSize;
		void rotation;
		void previewDimensions;
		void isStreamReady;
		void hasPaintedContent;
		void canvasAPI;
		scheduleMeasureFrame();
	});

	/** Element geometry: the canvas box itself, and the container it sits in. */
	$effect(() => {
		if (typeof ResizeObserver === 'undefined') return;

		const canvasElement = canvasAPI?.getCanvasElement?.();
		const observer = new ResizeObserver(() => scheduleMeasureFrame());

		if (canvasElement) observer.observe(canvasElement);
		if (previewContainer) observer.observe(previewContainer);

		scheduleMeasureFrame();
		return () => observer.disconnect();
	});

	/**
	 * Scrolling and window resizes move the rect without touching any observed
	 * box. `scroll` is captured because the pane that scrolls is an ancestor,
	 * and scroll events do not bubble.
	 */
	$effect(() => {
		if (typeof window === 'undefined') return;

		const onChange = () => scheduleMeasureFrame();
		window.addEventListener('resize', onChange);
		window.addEventListener('scroll', onChange, { capture: true, passive: true });

		return () => {
			window.removeEventListener('resize', onChange);
			window.removeEventListener('scroll', onChange, { capture: true });
		};
	});

	onDestroy(() => {
		if (measureFrameHandle !== undefined && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(measureFrameHandle);
		}
	});

	/**
	 * Cover the frame with something opaque.
	 *
	 * Keyed on whether the canvas has a picture, never on whether the *stream*
	 * is up. Those came apart constantly: `isStreamReady` is reset by every
	 * mid-session restart — a recovery, a watchdog round, a screencast refresh —
	 * and each one dropped a white panel over a canvas that was still showing a
	 * perfectly good frame, for as long as the handshake took. The guard meant
	 * to prevent that keyed on `lastFrameData`, whose writer no longer exists,
	 * so it was never true and never prevented anything.
	 */
	const showSolidOverlay = $derived(isLaunchingBrowser || !sessionInfo || !hasPaintedContent);

	// Navigation overlay state with debounce to prevent flickering during state transitions
	let showNavigationOverlay = $state(false);
	let overlayHideTimeout: ReturnType<typeof setTimeout> | null = null;

	// Immediately reset navigation overlay on tab switch to prevent stale overlay from old tab
	let previousOverlaySessionId: string | null = null;
	$effect(() => {
		if (sessionId !== previousOverlaySessionId) {
			previousOverlaySessionId = sessionId;
			if (overlayHideTimeout) {
				clearTimeout(overlayHideTimeout);
				overlayHideTimeout = null;
			}
			showNavigationOverlay = false;
		}
	});

	// Debounced navigation overlay - only for user-initiated toolbar navigations
	// In-browser navigations (link clicks) only show progress bar, not this overlay
	// This makes the preview behave like a real browser
	$effect(() => {
		const shouldShowOverlay = isNavigating && isStreamReady;

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
				// Re-check: only isNavigating controls this overlay.
				// isReconnecting is intentionally excluded — it serves a different purpose
				// (preventing solid loading overlay) and can stay true for a long time
				// (e.g. ICE recovery), which would keep the overlay stuck indefinitely.
				if (!isNavigating) {
					showNavigationOverlay = false;
				}
			}, 100); // 100ms debounce
		}
	});

	function handleTouchCursorUpdate(pos: { x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean }) {
		touchCursorPos = { x: pos.x, y: pos.y, visible: pos.visible, clicking: pos.clicking, pressed: pos.pressed };
	}

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
				canvasWidth: 1440,
				canvasHeight: 900,
				bodyWidth: '1440px',
				bodyHeight: '900px',
				screenOffsetLeft: '0px',
				screenOffsetTop: '0px',
				screenWidth: '1440px',
				screenHeight: '900px',
				screenRadius: '0px'
			};
			return;
		}

		const containerRect = previewContainer.getBoundingClientRect();
		// Small breathing room so the frame (and desktop stand) doesn't touch edges.
		const padding = 16;
		const availableWidth = Math.max(0, containerRect.width - padding);
		const availableHeight = Math.max(0, containerRect.height - padding);

		// Use getViewportDimensions for consistent viewport calculation
		// This ensures portrait = height > width, landscape = width > height
		const { width: canvasWidth, height: canvasHeight } = getViewportDimensions(
			deviceSize as DeviceSize,
			rotation as Rotation
		);

		// Include device bezel (and accessories) in the fit calculation so the whole
		// mockup stays inside the dock container regardless of root font-size.
		const frame = getFrameMetrics(deviceSize as DeviceSize, rotation as Rotation);
		const standReserve = frame.stand ? 42 : 0; // desktop stand extends below body
		const bodyWidth = canvasWidth + frame.left + frame.right;
		const bodyHeight = canvasHeight + frame.top + frame.bottom + frame.statusBarHeight;
		const totalWidth = bodyWidth;
		const totalHeight = bodyHeight + standReserve;

		// Scale to fit. Never scale up beyond original size (scale max = 1).
		const scaleX = availableWidth > 0 ? Math.min(1, availableWidth / totalWidth) : 1;
		const scaleY = availableHeight > 0 ? Math.min(1, availableHeight / totalHeight) : 1;
		const scale = Math.min(scaleX, scaleY);

		// Publish immediately — the streaming handshake reads this to pick a
		// capture resolution, and it runs before any scale-change event fires.
		setDisplayScale(scale);

		previewDimensions = {
			// Outer wrapper = full scaled footprint (body + stand accessory)
			width: `${totalWidth * scale}px`,
			height: `${totalHeight * scale}px`,
			scale,
			// Unscaled canvas (native viewport) — used inside DeviceFrame
			canvasWidth,
			canvasHeight,
			// Unscaled body (canvas + bezel) — used as the scaled transform target
			bodyWidth: `${bodyWidth}px`,
			bodyHeight: `${bodyHeight}px`,
			// Screen rect in scaled (display) pixels — used to position overlays
			// precisely over the canvas area, not the decorative bezel.
			screenOffsetLeft: `${frame.left * scale}px`,
			screenOffsetTop: `${(frame.top + frame.statusBarHeight) * scale}px`,
			screenWidth: `${canvasWidth * scale}px`,
			screenHeight: `${canvasHeight * scale}px`,
			screenRadius: `${frame.screenRadius * scale}px`
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
	{#if url}
		<!-- Scaled container for proper viewport simulation -->
		<div
			class="relative flex-shrink-0 {isMcpControlled
				? `ring-2 ring-offset-2 ring-offset-slate-900 rounded-xl ${isMcpFocused ? 'ring-amber-500' : 'ring-amber-500/40'}`
				: ''}"
			class:mcp-control-border={isMcpControlled && isMcpFocused}
			style="width: {previewDimensions.width}; height: {previewDimensions.height};"
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<!-- Device frame + canvas - always render when session exists so WebCodecs can start -->
			{#if sessionInfo}
				<div
					style="
						width: {previewDimensions.bodyWidth};
						height: {previewDimensions.bodyHeight};
						transform: scale({previewDimensions.scale});
						transform-origin: top left;
						transition: none;
					"
				>
					<DeviceFrame deviceSize={deviceSize as DeviceSize} rotation={rotation as Rotation}>
						<Canvas
							projectId={projectId}
							bind:sessionId
							bind:sessionInfo
							bind:deviceSize
							bind:rotation
							bind:canvasAPI
							bind:isConnected
							bind:isStreamReady
							bind:hasPaintedContent
							bind:isNavigating
							bind:isReconnecting
							bind:touchMode
							touchTarget={previewContainer}
							onInteraction={handleCanvasInteraction}
							onCursorUpdate={handleCursorUpdate}
							onFrameUpdate={handleFrameUpdate}
							onRequestScreencastRefresh={handleScreencastRefresh}
							onTouchCursorUpdate={handleTouchCursorUpdate}
						/>
					</DeviceFrame>
				</div>
			{/if}

			<!-- Solid Loading Overlay: Initial load states (launching, no session, waiting for first frame) -->
			{#if showSolidOverlay}
				<div
					class="absolute bg-white dark:bg-slate-800 flex items-center justify-center z-10"
					style="
						left: {previewDimensions.screenOffsetLeft};
						top: {previewDimensions.screenOffsetTop};
						width: {previewDimensions.screenWidth};
						height: {previewDimensions.screenHeight};
						border-radius: 0 0 {previewDimensions.screenRadius} {previewDimensions.screenRadius};
					"
				>
					<div class="flex flex-col items-center gap-2">
						<Icon name="lucide:loader-circle" class="w-8 h-8 animate-spin text-violet-600" />
						<div class="text-slate-500 text-center">
							<div class="text-sm">Loading preview...</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- Navigation Overlay: Only for user-initiated toolbar navigations (Go button/Enter) -->
			<!-- In-browser link clicks only show the progress bar, not this overlay -->
			{#if showNavigationOverlay}
				<div
					class="absolute bg-white/60 dark:bg-slate-800/60 backdrop-blur-[2px] flex items-center justify-center z-10"
					style="
						left: {previewDimensions.screenOffsetLeft};
						top: {previewDimensions.screenOffsetTop};
						width: {previewDimensions.screenWidth};
						height: {previewDimensions.screenHeight};
						border-radius: 0 0 {previewDimensions.screenRadius} {previewDimensions.screenRadius};
					"
				>
					<div class="flex flex-col items-center gap-2">
						<Icon name="lucide:loader-circle" class="w-8 h-8 animate-spin text-violet-600" />
						<div class="text-slate-600 dark:text-slate-300 text-center">
							<div class="text-sm font-medium">Navigating...</div>
						</div>
					</div>
				</div>
			{/if}

			<!--
				App-side way out of a page full screen. Anchored to the screen rect
				so it sits inside the device frame, above everything the page can
				draw, and clickable even while an agent holds the tab — being stuck
				full screen is not something the user should have to wait out.
			-->
			{#if isPageFullscreen}
				<!--
					Laid out as a right-aligned row over the screen rect rather than
					offset by hand: the button's own width is not knowable here, and
					a percentage in `left` would resolve against the frame, not the
					button. The row ignores pointer events so only the button itself
					takes them.
				-->
				<div
					class="pointer-events-none absolute z-30 flex justify-end p-3"
					style="
						left: {previewDimensions.screenOffsetLeft};
						top: {previewDimensions.screenOffsetTop};
						width: {previewDimensions.screenWidth};
					"
				>
					<button
						type="button"
						onclick={onExitFullscreen}
						class="pointer-events-auto flex items-center gap-1.5 rounded-full bg-slate-900/85 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-slate-900"
						title="Exit full screen"
					>
						<Icon name="lucide:minimize-2" class="h-3.5 w-3.5" />
						<span>Exit full screen</span>
					</button>
				</div>
			{/if}

			<!-- MCP Control Overlay - blocks user interaction (screen only) -->
			{#if isMcpControlled && hasPaintedContent}
				<div
					class="absolute z-20 pointer-events-auto cursor-not-allowed"
					role="presentation"
					aria-hidden="true"
					style="
						left: {previewDimensions.screenOffsetLeft};
						top: {previewDimensions.screenOffsetTop};
						width: {previewDimensions.screenWidth};
						height: {previewDimensions.screenHeight};
						background: transparent;
					"
					onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onmousedown={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onmousemove={(e) => { e.preventDefault(); e.stopPropagation(); }}
					onkeydown={(e) => { e.preventDefault(); e.stopPropagation(); }}
				></div>
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

	<!--
		Navigation failure. A sibling of the device frame, not nested inside it —
		it used to be anchored to the tiny screen rect, sitting *under* the MCP
		control-blocking overlay (same z-level, later in the DOM), which made
		"Try Again" unclickable while an agent held the tab. This also used to
		unmount DeviceFrame/Canvas entirely on error, tearing down the WebCodecs
		stream — "Try Again" now just re-navigates the same live session instead
		of forcing the whole panel through a fresh reconnect.
	-->
	{#if errorMessage && !isLaunchingBrowser && !isLoading}
		<div
			class="text-center text-slate-500 absolute z-40"
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
	{/if}

	<!-- Virtual Cursor - User -->
	{#if !isMcpControlled && localVirtualCursor.visible}
		<VirtualCursor cursor={localVirtualCursor} variant="user" />
	{/if}

	<!-- Touch Cursor - shown in cursor simulation mode -->
	{#if touchMode === 'cursor' && localTouchCursor.visible}
		<VirtualCursor cursor={localTouchCursor} variant="touch" />
	{/if}

	<!--
		Agent cursor. Amber, labelled, and always on top of the user's own.

		The caption names what the agent is doing when the backend has told us —
		"Agent · Typing". A bare "Agent" was accurate and useless: it is on screen
		for whole minutes now, and for that long the interesting question is not
		who is driving but what they are about to do to the page.
	-->
	{#if mcpCursor.visible}
		<VirtualCursor cursor={mcpCursor} variant="mcp" activity={mcpActivity} />
	{/if}

	<!--
		This tab is locked, but the agent is somewhere else. Says so, rather than
		leaving a blocked page with an amber ring and no explanation.
	-->
	{#if showAgentElsewhereHint}
		<div
			class="pointer-events-none absolute top-3 left-1/2 z-40 -translate-x-1/2"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			<span
				class="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-900/85 px-3 py-1.5 text-xs font-medium text-amber-200 shadow-lg backdrop-blur-sm"
			>
				<Icon name="lucide:external-link" class="h-3.5 w-3.5" />
				<span>Agent is working on another tab</span>
			</span>
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
