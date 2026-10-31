<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Canvas from './Canvas.svelte';
	import DeviceFrame from './DeviceFrame.svelte';
	import VirtualCursor from './VirtualCursor.svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onDestroy } from 'svelte';
	import {
		VIEWPORT_LIMITS,
		clampViewport,
		cornersToCss,
		getFrameLayout,
		type DeviceSize,
		type PageColors,
		type PreviewZoom,
		type Rect,
		type Rotation,
		type ViewportSize
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
		/** The page's exact size — the tab's, resolved by the parent. */
		viewport = { width: 1440, height: 900 } as ViewportSize,
		/** The device model whose mockup is drawn; the class default when null. */
		deviceModel = null as string | null,
		/** The colours the page asks to be framed in, read from its DOM. */
		pageColors = null as PageColors | null,
		/** Draw the device mockup. Off, or in responsive mode, the page stands alone. */
		showFrame = true,
		zoom = 'fit' as PreviewZoom,
		/** A size picked here — typed, dragged, or a breakpoint — for the parent to apply. */
		onResizeViewport = ((_size: ViewportSize) => {}) as (size: ViewportSize) => void,
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
		mcpCursorPage = null as { x: number; y: number; clicking?: boolean; pressed?: boolean; gliding?: boolean } | null,

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

		/**
		 * The user stopped this tab's load before it produced a page.
		 *
		 * A settled state, not a transient one: there is no session, so no
		 * frame is coming and the loading overlay would sit there for ever.
		 */
		loadStopped = false,

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

	type OverlayCursor = { x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean; gliding?: boolean };

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
			pressed: mcpCursorPage?.pressed,
			gliding: mcpCursorPage?.gliding
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
	const pageSize = $derived(viewport);

	/**
	 * Where everything in the mockup sits, unscaled. The same layout the frame
	 * draws from, so overlays and glow land exactly on the device.
	 */
	const layout = $derived(getFrameLayout(deviceSize as DeviceSize, viewport, showFrame, deviceModel));
	const isResponsive = $derived(deviceSize === 'responsive');


	/**
	 * Re-measure where the frame is painted.
	 *
	 * Cheap, idempotent, and safe to call from anywhere — it writes only when
	 * the numbers moved, so it cannot loop through the observers that call it.
	 * Sub-pixel jitter is ignored for the same reason.
	 */
	function measureFrame(): void {
		const rect = canvasAPI?.getPaintedRect?.();
		const box = previewContainer?.getBoundingClientRect();
		// The origin of the container's *content*, which is what an absolutely
		// placed overlay is positioned against. When zoomed past the panel the
		// container scrolls, and its box and its content part ways by exactly
		// the scroll offset.
		const container = box
			? {
					left: box.left - (previewContainer?.scrollLeft ?? 0),
					top: box.top - (previewContainer?.scrollTop ?? 0)
				}
			: null;

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
		void layout;
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
	const showSolidOverlay = $derived(
		!loadStopped && (isLaunchingBrowser || !sessionInfo || !hasPaintedContent)
	);

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

	/** Room left around the device for its glow and the desktop's shadow. */
	const FIT_PADDING = 40;

	// Calculate and update preview dimensions
	function calculatePreviewDimensions() {
		const frame = layout;
		const { footprint, screen } = frame;

		let scale = 1;
		if (previewContainer) {
			const containerRect = previewContainer.getBoundingClientRect();
			const availableWidth = Math.max(0, containerRect.width - FIT_PADDING);
			const availableHeight = Math.max(0, containerRect.height - FIT_PADDING);

			if (zoom === 'fit') {
				// Scale to fit, the whole mockup included. Never past 100%.
				const scaleX = availableWidth > 0 ? Math.min(1, availableWidth / footprint.width) : 1;
				const scaleY = availableHeight > 0 ? Math.min(1, availableHeight / footprint.height) : 1;
				scale = Math.min(scaleX, scaleY);
			} else {
				scale = zoom;
			}
		}

		// Publish immediately — the streaming handshake reads this to pick a
		// capture resolution, and it runs before any scale-change event fires.
		setDisplayScale(scale);

		previewDimensions = {
			// Outer wrapper = full scaled footprint (body + accessories)
			width: `${footprint.width * scale}px`,
			height: `${footprint.height * scale}px`,
			scale,
			// Unscaled page viewport
			canvasWidth: viewport.width,
			canvasHeight: viewport.height,
			// Unscaled footprint — the scaled transform target
			bodyWidth: `${footprint.width}px`,
			bodyHeight: `${footprint.height}px`,
			// Page rect in scaled (display) pixels — used to position overlays
			// precisely over the page, not the decorative frame.
			screenOffsetLeft: `${screen.x * scale}px`,
			screenOffsetTop: `${screen.y * scale}px`,
			screenWidth: `${screen.width * scale}px`,
			screenHeight: `${screen.height * scale}px`
		};
	}

	/** A rect from the layout, scaled and placed as an absolute overlay. */
	function scaledBox(rect: Rect, scale: number): string {
		return `left: ${rect.x * scale}px; top: ${rect.y * scale}px; width: ${rect.width * scale}px; height: ${rect.height * scale}px;`;
	}

	const currentScale = $derived(previewDimensions?.scale && previewDimensions.scale > 0 ? previewDimensions.scale : 1);
	const zoomPercent = $derived(Math.round(currentScale * 100));

	// ------------------------------------------------------------------
	// Responsive mode: typed size, breakpoints and drag handles
	// ------------------------------------------------------------------

	/** Common layout breakpoints, one click each. */
	const BREAKPOINTS = [
		{ label: '360', width: 360 },
		{ label: '768', width: 768 },
		{ label: '1024', width: 1024 },
		{ label: '1280', width: 1280 },
		{ label: '1440', width: 1440 }
	];

	let widthInput = $state('');
	let heightInput = $state('');
	$effect(() => {
		widthInput = String(viewport.width);
		heightInput = String(viewport.height);
	});

	const canResize = $derived(isResponsive && !isMcpControlled);

	function commitTypedSize() {
		const width = Number(widthInput);
		const height = Number(heightInput);
		if (!(width > 0) || !(height > 0)) {
			widthInput = String(viewport.width);
			heightInput = String(viewport.height);
			return;
		}
		const next = clampViewport({ width, height });
		widthInput = String(next.width);
		heightInput = String(next.height);
		if (next.width !== viewport.width || next.height !== viewport.height) onResizeViewport(next);
	}

	function handleSizeKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			(event.currentTarget as HTMLInputElement).blur();
		} else if (event.key === 'Escape') {
			widthInput = String(viewport.width);
			heightInput = String(viewport.height);
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

	/**
	 * A drag in progress, and the size it would land on.
	 *
	 * Nothing is sent while dragging: every size change restarts the capture,
	 * so streaming one per pointer move would stall the picture for the whole
	 * drag. An outline shows where the edge is going and the size is applied
	 * once, on release.
	 */
	let dragResize = $state<{
		axis: 'x' | 'y' | 'xy';
		startX: number;
		startY: number;
		start: ViewportSize;
		next: ViewportSize;
	} | null>(null);

	function startResize(event: PointerEvent, axis: 'x' | 'y' | 'xy') {
		if (!canResize || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		dragResize = {
			axis,
			startX: event.clientX,
			startY: event.clientY,
			start: { ...viewport },
			next: { ...viewport }
		};
	}

	function moveResize(event: PointerEvent) {
		const drag = dragResize;
		if (!drag) return;
		// The page stays centred, so an edge moves half as far as the size
		// grows: double the pointer's travel to keep the edge under it.
		const dx = ((event.clientX - drag.startX) * 2) / currentScale;
		const dy = ((event.clientY - drag.startY) * 2) / currentScale;
		dragResize = {
			...drag,
			next: clampViewport({
				width: drag.axis === 'y' ? drag.start.width : drag.start.width + dx,
				height: drag.axis === 'x' ? drag.start.height : drag.start.height + dy
			})
		};
	}

	function endResize(event: PointerEvent) {
		const drag = dragResize;
		if (!drag) return;
		(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		dragResize = null;
		if (drag.next.width !== drag.start.width || drag.next.height !== drag.start.height) {
			onResizeViewport(drag.next);
		}
	}

	/** The outline of a drag in progress, centred on the page like the page itself. */
	const dragOutline = $derived.by(() => {
		if (!dragResize) return null;
		const { screen } = layout;
		const width = dragResize.next.width * currentScale;
		const height = dragResize.next.height * currentScale;
		return {
			left: (screen.x + screen.width / 2) * currentScale - width / 2,
			top: (screen.y + screen.height / 2) * currentScale - height / 2,
			width,
			height
		};
	});

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

	/**
	 * Ask the source to re-send — the Canvas watchdog's cheap repair.
	 *
	 * Carried as a scale update because that is the message the source treats as
	 * "rebuild your capture".
	 *
	 * Falling back to 1 matters: the scale is only known once the container has
	 * been measured, and skipping the send while it is not made the watchdog's
	 * recovery a silent no-op in exactly the case it exists for — a preview that
	 * has never painted anything.
	 */
	function handleScreencastRefresh() {
		const scale = previewDimensions?.scale && previewDimensions.scale > 0 ? previewDimensions.scale : 1;
		debug.log('preview', `📐 Requesting screencast refresh with scale: ${scale}`);
		sendScaleUpdate(scale);
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
			void layout;
			void zoom;
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

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<!--
		Responsive mode: the size is the user's to set, so the controls for it
		sit right above the page rather than in a menu.
	-->
	{#if url && isResponsive}
		<div
			class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300"
		>
			<div class="flex items-center gap-1">
				<input
					type="number"
					inputmode="numeric"
					min={VIEWPORT_LIMITS.min}
					max={VIEWPORT_LIMITS.max}
					bind:value={widthInput}
					onblur={commitTypedSize}
					onkeydown={handleSizeKeydown}
					disabled={!canResize}
					aria-label="Viewport width"
					class="size-input w-16 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-center tabular-nums outline-none focus:border-violet-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
				/>
				<span class="text-slate-400">×</span>
				<input
					type="number"
					inputmode="numeric"
					min={VIEWPORT_LIMITS.min}
					max={VIEWPORT_LIMITS.max}
					bind:value={heightInput}
					onblur={commitTypedSize}
					onkeydown={handleSizeKeydown}
					disabled={!canResize}
					aria-label="Viewport height"
					class="size-input w-16 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-center tabular-nums outline-none focus:border-violet-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
				/>
				<span class="ml-1 tabular-nums text-slate-400">{zoomPercent}%</span>
			</div>
			<div class="flex items-center gap-0.5">
				{#each BREAKPOINTS as breakpoint (breakpoint.width)}
					<button
						type="button"
						disabled={!canResize}
						onclick={() => onResizeViewport(clampViewport({ width: breakpoint.width, height: viewport.height }))}
						class="rounded px-1.5 py-0.5 tabular-nums transition-colors hover:bg-violet-500/10 hover:text-violet-600 disabled:pointer-events-none disabled:opacity-50 {viewport.width === breakpoint.width ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : ''}"
						title="Width {breakpoint.width}px"
					>
						{breakpoint.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}

<!-- Preview Container with scaling -->
<div
	bind:this={previewContainer}
	class="flex-1 relative p-0.5 flex min-h-0 min-w-0 {zoom === 'fit' ? 'overflow-hidden' : 'overflow-auto'}"
	style="justify-content: safe center; align-items: safe center;"
>
	{#if url}
		<!-- Scaled container for proper viewport simulation -->
		<div
			class="relative flex-shrink-0"
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
					<DeviceFrame deviceSize={deviceSize as DeviceSize} {viewport} {deviceModel} {showFrame} {pageColors}>
						<Canvas
							projectId={projectId}
							{viewport}
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
						border-radius: {cornersToCss(layout.screenRadius, currentScale)};
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
						border-radius: {cornersToCss(layout.screenRadius, currentScale)};
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

			<!--
				Agent control: the edge of the screen glows, inside the device and
				along the display's own rounded corners — the mockup itself stays
				as it is. Held but not being worked on, it rests dim; while the
				agent acts it breathes. Only opacity animates: a pulsing
				box-shadow would repaint every frame right next to a video.
			-->
			{#if isMcpControlled && sessionInfo}
				<div
					class="mcp-edge pointer-events-none absolute z-[15]"
					class:mcp-edge-active={isMcpFocused}
					style="{scaledBox(layout.display, currentScale)} border-radius: {cornersToCss(layout.displayRadius, currentScale)};"
				></div>
			{/if}

			<!-- Responsive resize: an outline of where a drag will land, then handles. -->
			{#if dragOutline && dragResize}
				<div
					class="pointer-events-none absolute z-30 rounded-sm border-2 border-dashed border-violet-500 bg-violet-500/5"
					style="left: {dragOutline.left}px; top: {dragOutline.top}px; width: {dragOutline.width}px; height: {dragOutline.height}px;"
				>
					<span
						class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-slate-900/85 px-2 py-1 text-xs font-medium tabular-nums text-white"
					>
						{dragResize.next.width} × {dragResize.next.height}
					</span>
				</div>
			{/if}
			{#if canResize && sessionInfo}
				<div
					class="resize-handle resize-handle-x absolute z-30"
					style="left: {(layout.screen.x + layout.screen.width) * currentScale}px; top: {(layout.screen.y + layout.screen.height / 2) * currentScale}px;"
					role="separator"
					aria-orientation="vertical"
					aria-label="Drag to change the viewport width"
					onpointerdown={(e) => startResize(e, 'x')}
					onpointermove={moveResize}
					onpointerup={endResize}
					onpointercancel={endResize}
				></div>
				<div
					class="resize-handle resize-handle-y absolute z-30"
					style="left: {(layout.screen.x + layout.screen.width / 2) * currentScale}px; top: {(layout.screen.y + layout.screen.height) * currentScale}px;"
					role="separator"
					aria-orientation="horizontal"
					aria-label="Drag to change the viewport height"
					onpointerdown={(e) => startResize(e, 'y')}
					onpointermove={moveResize}
					onpointerup={endResize}
					onpointercancel={endResize}
				></div>
				<div
					class="resize-handle resize-handle-xy absolute z-30"
					style="left: {(layout.screen.x + layout.screen.width) * currentScale}px; top: {(layout.screen.y + layout.screen.height) * currentScale}px;"
					role="separator"
					aria-label="Drag to change the viewport size"
					onpointerdown={(e) => startResize(e, 'xy')}
					onpointermove={moveResize}
					onpointerup={endResize}
					onpointercancel={endResize}
				></div>
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

	<!--
		Stopped on purpose. Shares the failure panel's shape because it is the
		same kind of moment — nothing to show, and one obvious way forward —
		but it is not an error: the user asked for this, so it is not dressed
		as something that went wrong.
	-->
	{#if loadStopped && !errorMessage}
		<div
			class="text-center text-slate-500 absolute z-40"
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<Icon name="lucide:circle-slash" class="w-16 h-16 mx-auto mb-4 opacity-25" />
			<p class="text-lg font-medium mb-2 text-slate-700 dark:text-slate-300">Loading stopped</p>
			<p class="text-sm mb-4 text-slate-600 dark:text-slate-400 max-w-md">
				Nothing had loaded yet, so there is nothing to show.
			</p>
			<button
				onclick={handleRetryClick}
				class="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition-colors duration-200 inline-flex items-center gap-2"
			>
				<Icon name="lucide:refresh-cw" class="w-4 h-4" />
				<span>Load again</span>
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
</div>

<style>
	/*
	 * Agent control glow, inside the screen. The resting glow is declared on
	 * the class so "the agent is driving this browser" stays visible when the
	 * pulse is dropped (reduced motion) — the keyframes only breathe its
	 * opacity.
	 */
	.mcp-edge {
		box-shadow:
			inset 0 0 0 1.5px rgba(245, 158, 11, 0.8),
			inset 0 0 24px 2px rgba(245, 158, 11, 0.35);
		opacity: 0.45;
		will-change: opacity;
	}

	.mcp-edge-active {
		opacity: 1;
		animation: mcp-breathe 2s ease-in-out infinite;
	}

	@keyframes mcp-breathe {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mcp-edge-active {
			animation: none;
			opacity: 1;
		}
	}

	/* Responsive resize handles: a grip pill on each draggable edge. */
	.resize-handle {
		touch-action: none;
		border-radius: 999px;
		background: rgb(148 163 184 / 0.7);
		transition: background-color 150ms;
	}

	.resize-handle:hover,
	.resize-handle:active {
		background: rgb(139 92 246);
	}

	.resize-handle-x {
		width: 6px;
		height: 44px;
		transform: translate(4px, -50%);
		cursor: ew-resize;
	}

	.resize-handle-y {
		width: 44px;
		height: 6px;
		transform: translate(-50%, 4px);
		cursor: ns-resize;
	}

	.resize-handle-xy {
		width: 12px;
		height: 12px;
		transform: translate(3px, 3px);
		border-radius: 3px;
		cursor: nwse-resize;
	}

	/* Plain digits in the size fields, no spinner arrows. */
	.size-input::-webkit-outer-spin-button,
	.size-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.size-input {
		-moz-appearance: textfield;
		appearance: textfield;
	}
</style>
