<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getViewportDimensions, type DeviceSize, type Rotation } from '$frontend/utils/preview-constants';
	import { BrowserWebCodecsService, type BrowserWebCodecsStreamStats } from '$frontend/services/preview/browser/browser-webcodecs.service';
	import { probeHitTest, readPageSelection, type RemoteFocusState } from '../core/interactions.svelte';
	import { debug } from '$shared/utils/logger';

	/**
	 * Touch capability, resolved once. Only touch devices get the hidden keyboard
	 * field — on a desktop it would steal focus from the canvas and break the
	 * physical keyboard path.
	 */
	const isTouchDevice =
		typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

	let {
		projectId = '', // REQUIRED for project isolation (read-only from parent)
		sessionId = $bindable<string | null>(null),
		sessionInfo = $bindable<any>(null),
		deviceSize = $bindable<DeviceSize>('laptop'),
		rotation = $bindable<Rotation>('portrait'),
		currentCursor = $bindable('default'),
		canvasAPI = $bindable<any>(null),
		lastFrameData = $bindable<any>(null),
		isConnected = $bindable(false),
		latencyMs = $bindable<number>(0),
		isStreamReady = $bindable(false), // Exposed: true when first frame received
		isNavigating = $bindable(false), // Track if page is navigating (from parent)
		isReconnecting = $bindable(false), // Track if reconnecting after navigation (prevents loading overlay)

		// Callbacks for interactions
		onInteraction = $bindable<(action: any) => void>(() => {}),
		onCursorUpdate = $bindable<(cursor: string) => void>(() => {}),
		onFrameUpdate = $bindable<(data: any) => void>(() => {}),
		onStatsUpdate = $bindable<(stats: BrowserWebCodecsStreamStats | null) => void>(() => {}),
		onRequestScreencastRefresh = $bindable<() => void>(() => {}), // Called when stream is stuck
		touchMode = $bindable<'scroll' | 'cursor'>('scroll'),
		touchTarget = undefined as HTMLElement | undefined, // Container element for touch events
		onTouchCursorUpdate = $bindable<(pos: { x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean }) => void>(() => {})
	} = $props();

	/**
	 * The page's own coordinate space — the emulated viewport, in CSS pixels.
	 *
	 * Deliberately *not* derived from the canvas bitmap. The renderer sizes the
	 * backing store to whatever resolution the stream is currently captured at,
	 * and that resolution is adaptive: it follows fit-scale × devicePixelRatio and
	 * is clamped by the host's pixel budget. Mapping through the bitmap therefore
	 * produced coordinates scaled by `capture ÷ viewport` — exact whenever that
	 * ratio happened to be 1 (a Retina screen at half fit, which is why it looked
	 * accurate most of the time) and off by a few percent, growing toward the
	 * bottom-right, whenever it wasn't. The backend dispatches these as CSS
	 * pixels, so CSS pixels is what this has to produce.
	 */
	const pageSize = $derived(
		getViewportDimensions(
			(deviceSize || sessionInfo?.deviceSize || 'laptop') as DeviceSize,
			(rotation || sessionInfo?.rotation || 'landscape') as Rotation
		)
	);

	// WebCodecs service instance
	let webCodecsService: BrowserWebCodecsService | null = null;
	let isWebCodecsActive = $state(false);
	let activeStreamingSessionId: string | null = null; // Track which session is currently streaming
	let isStartingStream = false; // Prevent concurrent start attempts
	let lastStartRequestId: string | null = null; // Track the last start request to prevent duplicates

	// Generation counter: increments on every session change (tab switch).
	// Async operations (startStreaming, recovery) capture the current generation
	// and bail out if it has changed, preventing stale operations from corrupting
	// the new tab's state.
	let streamingGeneration = 0;

	let canvasElement = $state<HTMLCanvasElement | undefined>();
	let setupCanvasTimeout: ReturnType<typeof setTimeout> | undefined;

	// Health check and recovery - EVENT-DRIVEN, not timeout-based
	let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
	let initialFrameCheckInterval: ReturnType<typeof setInterval> | undefined;
	let lastFrameTime = 0;
	let consecutiveFailures = $state(0); // Made reactive for UI
	let hasReceivedFirstFrame = $state(false); // Made reactive for UI
	let isStreamStarting = $state(false); // Track when stream is being started
	let isRecovering = $state(false); // Track recovery attempts
	let connectionFailed = $state(false); // Track if connection actually failed (not just slow)
	let hasRequestedScreencastRefresh = false; // Track if we've already requested refresh for this stream
	let screencastRefreshCount = 0; // Track retry count for stuck detection
	let navigationJustCompleted = false; // Track if navigation just completed (for fast refresh)

	// Watchdog bookkeeping — see WATCHDOG_* above. Plain locals: nothing renders
	// from them, and making them reactive would re-run effects once a second.
	let blankSince = 0;
	let watchdogRound = 0;

	// Canvas snapshot storage for instant tab switching
	// Stores a clone of the canvas per sessionId so switching back shows content immediately
	const canvasSnapshots = new Map<string, HTMLCanvasElement>();
	const MAX_SNAPSHOTS = 10;
	let hasRestoredSnapshot = false; // Prevents canvas clear/reset during streaming start

	// Recovery is triggered by ACTUAL failures — ICE failed, the WebCodecs
	// connection closed unexpectedly, an explicit error — and, as a last resort,
	// by the watchdog below when none of those fired but there is still no
	// picture. This bounds how many attempts one *round* makes before backing
	// off; the watchdog opens the next round.
	const MAX_CONSECUTIVE_FAILURES = 2;
	const HEALTH_CHECK_INTERVAL = 2000; // Check every 2 seconds for connection health
	const FRAME_CHECK_INTERVAL = 100; // Fallback poll for first frame (primary path is onFirstFrame callback)
	const STUCK_STREAM_TIMEOUT = 3000; // Fallback: Request screencast refresh after 3 seconds of connected but no frame
	const NAVIGATION_FAST_REFRESH_DELAY = 300; // Fast refresh after navigation: 300ms

	/**
	 * Last-resort watchdog: how long a session may show nothing before this
	 * component starts the whole handshake again, and how much longer it waits
	 * on each further attempt.
	 *
	 * Everything above only recovers from a failure it was told about — an ICE
	 * `failed`, a DataChannel close, a stream that connected and then produced
	 * no frame. Three ways to end up with no picture and no recovery at all were
	 * left over, and all three ended in a permanent "Loading preview…":
	 *
	 * - `startStreaming()` exhausting its retries. Nothing re-runs it: the
	 *   streaming effect's dependencies have not changed, so it never fires again.
	 * - A peer that never reaches `connected`. The stuck-stream ladder is gated
	 *   on `isConnected`, and ICE can sit in `checking` indefinitely without ever
	 *   declaring `failed` — much likelier over a Remote Access link than on the
	 *   host, which is exactly where it was seen to hang forever.
	 * - `attemptRecovery()` giving up after two tries and stopping the stream for
	 *   good.
	 *
	 * This is deliberately outside all of that: it looks only at whether a frame
	 * has ever arrived, so it cannot be defeated by a wrong diagnosis. The delay
	 * grows a little per round to stay out of the way of a link that is merely
	 * slow, and is capped — a viewer that is looking at a spinner must never be
	 * left waiting minutes for the next attempt.
	 */
	const WATCHDOG_TICK_MS = 1000;
	const WATCHDOG_FIRST_ESCALATION_MS = 8000;
	const WATCHDOG_ESCALATION_STEP_MS = 3000;
	const WATCHDOG_MAX_WAIT_MS = 15000;

	// Sync isStreamReady with hasReceivedFirstFrame for parent component
	$effect(() => {
		isStreamReady = hasReceivedFirstFrame;
	});

	// Watch projectId changes and recreate WebCodecs service
	let lastProjectId = '';
	$effect(() => {
		const currentProjectId = projectId;

		// Project changed - destroy and recreate service
		if (lastProjectId && currentProjectId && lastProjectId !== currentProjectId) {
			debug.log('webcodecs', `🔄 Project changed (${lastProjectId} → ${currentProjectId}), destroying old WebCodecs service`);

			// Clear canvas snapshots - they belong to old project's sessions
			canvasSnapshots.clear();
			hasRestoredSnapshot = false;
			lastStartRequestId = null; // Clear so new project sessions aren't blocked by old tab IDs

			// Destroy old service
			if (webCodecsService) {
				webCodecsService.destroy();
				webCodecsService = null;
				activeStreamingSessionId = null;
				isWebCodecsActive = false;
			}
		}

		lastProjectId = currentProjectId;
	});

	// Track session changes to reset stale state and increment generation counter.
	// This runs BEFORE the streaming $effect, ensuring isReconnecting from the old
	// tab doesn't leak into the new tab and that stale async operations bail out.
	let lastTrackedSessionId: string | null = null;
	$effect(() => {
		const currentSessionId = sessionId;
		if (currentSessionId !== lastTrackedSessionId) {
			if (lastTrackedSessionId !== null) {
				// Session actually changed (tab switch) — not initial mount
				streamingGeneration++;
				debug.log('webcodecs', `Session changed ${lastTrackedSessionId} → ${currentSessionId}, generation=${streamingGeneration}`);

				// Reset states that belong to the old tab
				if (isReconnecting) {
					isReconnecting = false;
				}
				if (isNavigating) {
					isNavigating = false;
				}
				lastStartRequestId = null; // Allow new start request for new session
			}
			lastTrackedSessionId = currentSessionId;
			// A new tab starts its own patience: carrying the previous one's
			// stopwatch over would fire the watchdog on its very first tick.
			blankSince = 0;
			watchdogRound = 0;
		}
	});

	// Sync navigation state with webCodecsService
	// This prevents recovery when DataChannel closes during navigation
	$effect(() => {
		if (webCodecsService) {
			webCodecsService.setNavigating(isNavigating);
			if (isNavigating) {
				debug.log('webcodecs', 'Navigation started - recovery will be suppressed');
			}
		}
	});

	// Convert CSS cursor values to canvas cursor styles
	function mapCursorStyle(browserCursor: string): string {
		const cursorMap: Record<string, string> = {
			'default': 'default',
			'auto': 'default',
			'pointer': 'pointer',
			'text': 'text',
			'wait': 'wait',
			'crosshair': 'crosshair',
			'help': 'help',
			'move': 'move',
			'n-resize': 'n-resize',
			's-resize': 's-resize',
			'e-resize': 'e-resize',
			'w-resize': 'w-resize',
			'ne-resize': 'ne-resize',
			'nw-resize': 'nw-resize',
			'se-resize': 'se-resize',
			'sw-resize': 'sw-resize',
			'ew-resize': 'ew-resize',
			'ns-resize': 'ns-resize',
			'nesw-resize': 'nesw-resize',
			'nwse-resize': 'nwse-resize',
			'grab': 'grab',
			'grabbing': 'grabbing',
			'not-allowed': 'not-allowed',
			'no-drop': 'no-drop',
			'copy': 'copy',
			'alias': 'alias',
			'context-menu': 'context-menu',
			'cell': 'cell',
			'vertical-text': 'vertical-text',
			'all-scroll': 'all-scroll',
			'col-resize': 'col-resize',
			'row-resize': 'row-resize',
			'zoom-in': 'zoom-in',
			'zoom-out': 'zoom-out'
		};

		return cursorMap[browserCursor] || 'default';
	}

	// Update canvas cursor style
	function updateCanvasCursor(newCursor: string) {
		if (canvasElement && newCursor !== currentCursor) {
			const mappedCursor = mapCursorStyle(newCursor);
			canvasElement.style.cursor = mappedCursor;
			currentCursor = newCursor;
			onCursorUpdate(newCursor);
		}
	}

	// Interactive canvas functions
	async function sendInteraction(action: any) {
		if (!sessionId) return;
		onInteraction(action);
	}

	/**
	 * Map a viewport point onto the page's own coordinate space.
	 *
	 * `getBoundingClientRect()` already accounts for the fit-scale transform the
	 * device frame applies, so the ratio between the bitmap size and the rendered
	 * box is the whole conversion.
	 *
	 * `inside` matters because touch gestures are bound to the *panel*, not the
	 * canvas — the trackpad mode needs the whole panel as a surface. A tap on the
	 * bezel or the dot-pattern backdrop therefore lands here with coordinates
	 * outside the page, and forwarding those unclamped is what made taps register
	 * in the wrong place.
	 */
	/**
	 * Where the frame is actually painted inside the canvas element.
	 *
	 * The canvas is `object-contain`, so whenever the element's box and the
	 * bitmap disagree on aspect ratio the image is letterboxed and centred inside
	 * it. Mapping against the element box then reports every point offset by
	 * however wide those bars are — which is what put clicks up-and-left of the
	 * pointer after a rotation change, and the virtual cursor down-and-right on
	 * mobile. The painted rect is the only correct frame of reference.
	 */
	function paintedRect(canvas: HTMLCanvasElement): DOMRect | null {
		const rect = canvas.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) {
			return null;
		}

		const boxAspect = rect.width / rect.height;
		const bitmapAspect = canvas.width / canvas.height;

		if (Math.abs(boxAspect - bitmapAspect) < 0.0001) return rect;

		if (bitmapAspect > boxAspect) {
			// Limited by width — bars above and below.
			const height = rect.width / bitmapAspect;
			return new DOMRect(rect.left, rect.top + (rect.height - height) / 2, rect.width, height);
		}

		// Limited by height — bars left and right.
		const width = rect.height * bitmapAspect;
		return new DOMRect(rect.left + (rect.width - width) / 2, rect.top, width, rect.height);
	}

	function toPageCoordinates(
		clientX: number,
		clientY: number,
		canvas: HTMLCanvasElement
	): { x: number; y: number; inside: boolean } {
		const rect = paintedRect(canvas);
		if (!rect) return { x: 0, y: 0, inside: false };

		// Painted box → page, never bitmap → page. See `pageSize`.
		const scaleX = pageSize.width / rect.width;
		const scaleY = pageSize.height / rect.height;

		const rawX = (clientX - rect.left) * scaleX;
		const rawY = (clientY - rect.top) * scaleY;

		const inside =
			clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;

		return {
			// Clamped so a gesture that drifts off the edge mid-drag keeps
			// tracking against the nearest page pixel instead of jumping.
			x: Math.round(Math.max(0, Math.min(pageSize.width, rawX))),
			y: Math.round(Math.max(0, Math.min(pageSize.height, rawY))),
			inside
		};
	}

	/**
	 * How many page pixels one CSS pixel of the panel covers.
	 *
	 * Gesture deltas (touch scroll, trackpad travel) need the same conversion as
	 * points do, or a scroll moves the page by a different distance than the
	 * finger travelled.
	 */
	function pageScale(canvas: HTMLCanvasElement): number {
		const rect = paintedRect(canvas);
		if (!rect || rect.width === 0) return 1;
		return pageSize.width / rect.width;
	}

	// Utility function to convert canvas display coordinates to browser coordinates
	function getCanvasCoordinates(event: MouseEvent | TouchEvent, canvas: HTMLCanvasElement): { x: number, y: number } {
		let clientX: number, clientY: number;

		if (event instanceof MouseEvent) {
			clientX = event.clientX;
			clientY = event.clientY;
		} else {
			const touch = event.touches[0] || event.changedTouches[0];
			clientX = touch.clientX;
			clientY = touch.clientY;
		}

		const { x, y } = toPageCoordinates(clientX, clientY, canvas);
		return { x, y };
	}

	/**
	 * Follow one finger for the length of a gesture.
	 *
	 * `touches[0]` is not stable: a second finger touching down can reorder the
	 * list, and the tracked point jumps to the new finger mid-scroll. Matching on
	 * `identifier` pins the gesture to the finger that started it.
	 */
	function findTouch(event: TouchEvent, identifier: number | null): Touch | null {
		if (identifier === null) return event.touches[0] ?? event.changedTouches[0] ?? null;

		for (const list of [event.touches, event.changedTouches]) {
			for (let i = 0; i < list.length; i += 1) {
				if (list[i].identifier === identifier) return list[i];
			}
		}
		return null;
	}


	/**
	 * How far the pointer must travel, in page pixels, before a press counts as a
	 * drag rather than a click.
	 *
	 * Nothing is dispatched until it is crossed — the press has to stay a
	 * candidate click, because that path is what detects selects and pickers. So
	 * the distance is also how much of a text selection is missing before it
	 * starts: at 10px that was the first character or so. 4px matches what
	 * browsers themselves use to start a drag.
	 */
	const DRAG_THRESHOLD_PX = 4;

	function handleCanvasMouseMove(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;

		const coords = getCanvasCoordinates(event, canvas);

		if (isMouseDown && dragStartPos) {
			dragCurrentPos = { x: coords.x, y: coords.y };

			const dragDistance = Math.sqrt(
				Math.pow(coords.x - dragStartPos.x, 2) + Math.pow(coords.y - dragStartPos.y, 2)
			);

			// Start drag when distance exceeds threshold
			if (dragDistance > DRAG_THRESHOLD_PX) {
				// Send mousedown on first drag detection
				if (!dragStarted) {
					sendInteraction({
						type: 'mousedown',
						x: dragStartPos.x,
						y: dragStartPos.y,
						button: event.button === 2 ? 'right' : 'left'
					});
					dragStarted = true;
				}

				isDragging = true;
				// Send mousemove to continue dragging (mouse is already down)
				sendInteraction({
					type: 'mousemove',
					x: coords.x,
					y: coords.y
				});
			}
		} else if (!isMouseDown) {
			sendInteraction({
				type: 'mousemove',
				x: coords.x,
				y: coords.y
			});
		}
	}

	function handleCanvasDoubleClick(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;
		const coords = getCanvasCoordinates(event, canvas);
		sendInteraction({ type: 'doubleclick', x: coords.x, y: coords.y });
	}

	function handleCanvasRightClick(event: MouseEvent, canvas: HTMLCanvasElement) {
		event.preventDefault();
		if (!sessionId) return;
		const coords = getCanvasCoordinates(event, canvas);
		sendInteraction({ type: 'rightclick', x: coords.x, y: coords.y });
	}

	function handleCanvasWheel(event: WheelEvent, canvas: HTMLCanvasElement) {
		event.preventDefault();
		if (!sessionId) return;
		sendInteraction({ type: 'scroll', deltaX: event.deltaX, deltaY: event.deltaY });
	}

	/**
	 * Bridge the clipboard shortcuts between the page and the user's own machine.
	 *
	 * Forwarding Ctrl+C as a keystroke fills the *headless* browser's clipboard,
	 * which nothing outside the preview can read — and Ctrl+V would paste from
	 * that same invisible clipboard rather than the user's. Both directions have
	 * to be carried explicitly.
	 */
	async function handleClipboardShortcut(event: KeyboardEvent): Promise<boolean> {
		const mod = event.metaKey || event.ctrlKey;
		if (!mod || event.altKey) return false;

		const key = event.key.toLowerCase();

		if (key === 'c' || key === 'x') {
			const text = await readPageSelection(key === 'x');
			if (text) {
				try {
					await navigator.clipboard.writeText(text);
				} catch (error) {
					debug.warn('preview', 'Could not write the preview selection to the clipboard:', error);
				}
			}
			return true;
		}

		if (key === 'v') {
			try {
				// A keydown counts as a user gesture, which is what Chrome requires
				// before it will hand over clipboard contents.
				const text = await navigator.clipboard.readText();
				if (text) sendInteraction({ type: 'paste', text });
			} catch (error) {
				debug.warn('preview', 'Could not read the clipboard for paste:', error);
			}
			return true;
		}

		return false;
	}

	function handleCanvasKeydown(event: KeyboardEvent) {
		if (!sessionId) return;

		// Prevent default for all keyboard events to avoid affecting parent page
		// This prevents Ctrl+A, Ctrl+C, arrow keys, etc. from affecting the parent
		event.preventDefault();
		event.stopPropagation();

		// Copy/cut/paste are handled here rather than forwarded as keystrokes.
		if (event.metaKey || event.ctrlKey) {
			const key = event.key.toLowerCase();
			if (key === 'c' || key === 'x' || key === 'v') {
				void handleClipboardShortcut(event);
				return;
			}
		}

		const isNavigationKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Escape'].includes(event.key);
		const isModifierKey = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;

		if (isNavigationKey) {
			sendInteraction({
				type: 'keynav',
				key: event.key,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey
			});
		} else if (event.key.length === 1 && !isModifierKey) {
			sendInteraction({ type: 'type', text: event.key, delay: 50 });
		} else {
			sendInteraction({
				type: 'key',
				key: event.key,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey
			});
		}
	}

	// State variables for drag-drop functionality
	let isDragging = $state(false);
	let isMouseDown = $state(false);
	let dragStartPos = $state<{x: number, y: number} | null>(null);
	let dragCurrentPos = $state<{x: number, y: number} | null>(null);
	let mouseDownTime = $state(0);
	let dragStarted = $state(false); // Track if we've sent mousedown for drag

	// Touch-specific tracking (non-reactive for performance)
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let touchLongPressed = false;
	let lastTouchCoords: { x: number; y: number } | null = null;
	/** Identifier of the finger that owns the current gesture. */
	let activeTouchId: number | null = null;

	// Trackpad cursor state (cursor/trackpad mode - persists between touch gestures)
	let trackpadCursorX = 0;
	let trackpadCursorY = 0;
	let trackpadLastClientX = 0;
	let trackpadLastClientY = 0;
	let trackpadTouchStartClientX = 0;
	let trackpadTouchStartClientY = 0;
	let trackpadTwoFingerActive = false;
	let trackpadTwoFingerStartTime = 0;
	let trackpadTwoFingerLastCenterX = 0;
	let trackpadTwoFingerLastCenterY = 0;
	let trackpadTwoFingerTotalDist = 0;
	/**
	 * A two-finger gesture has happened and not every finger is off the glass.
	 *
	 * Fingers never leave together. Whichever one lifts first used to be read as
	 * the end of the two-finger gesture and the *start* of a single-finger tap,
	 * so ending a two-finger scroll fired a click wherever the cursor happened
	 * to be — and the two-finger tap that should have opened a context menu was
	 * consumed by that same transition before it could be recognised. The
	 * gesture is now decided the moment the count drops below two, and nothing
	 * else is read from the remaining fingers until the glass is clear.
	 */
	let trackpadGestureSettled = false;

	/**
	 * Double-tap-and-drag, the trackpad idiom for "press and hold while moving".
	 *
	 * Long-press was the only way to start a drag, which costs 600ms before
	 * anything happens and is unusable for selecting text. A second tap that
	 * lands quickly and then moves means the same thing and starts immediately;
	 * one that lands and lifts again is just a double-click.
	 */
	let trackpadLastTapAt = 0;
	let trackpadDoubleTapArmed = false;
	/** Longest gap between the two taps that still reads as one gesture. */
	const DOUBLE_TAP_WINDOW_MS = 320;

	/** Show the touch cursor at its current spot, optionally mid-gesture. */
	function publishTouchCursor(state: { clicking?: boolean; pressed?: boolean } = {}) {
		if (!canvasElement) return;
		const pos = canvasToScreen(trackpadCursorX, trackpadCursorY);
		onTouchCursorUpdate({ x: pos.x, y: pos.y, visible: true, ...state });
	}

	/**
	 * Flash the click ripple, then settle back.
	 *
	 * A tap on a trackpad surface lands somewhere the finger is not, so without
	 * a mark on the cursor there is nothing to confirm the tap registered —
	 * the same reason the agent's pointer draws one.
	 */
	function pulseTouchCursor(pressed = false) {
		publishTouchCursor({ clicking: true, pressed });
		setTimeout(() => {
			if (touchMode === 'cursor') publishTouchCursor({ pressed });
		}, 220);
	}

	function handleCanvasMouseDown(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;

		const coords = getCanvasCoordinates(event, canvas);

		isMouseDown = true;
		mouseDownTime = Date.now();
		dragStartPos = { x: coords.x, y: coords.y };
		dragCurrentPos = { x: coords.x, y: coords.y };
		dragStarted = false; // Reset drag started flag
	}

	function handleCanvasMouseUp(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || !isMouseDown) return;

		const coords = getCanvasCoordinates(event, canvas);

		if (dragStartPos) {
			// If drag was started (mousedown was sent), send mouseup
			if (dragStarted) {
				sendInteraction({
					type: 'mouseup',
					x: coords.x,
					y: coords.y,
					button: event.button === 2 ? 'right' : 'left'
				});
			} else {
				// No drag occurred, this is a click
				// IMPORTANT: Only send click for left mouse button (button === 0)
				// Right-click (button === 2) is handled by contextmenu event
				if (event.button === 0) {
					sendInteraction({ type: 'click', x: dragStartPos.x, y: dragStartPos.y });
				}
			}
		}

		isMouseDown = false;
		isDragging = false;
		dragStartPos = null;
		dragCurrentPos = null;
		dragStarted = false;
	}

	function setupCanvasInternal() {
		if (!sessionInfo) return;

		// IMPORTANT: Use props as primary source of truth, fallback to sessionInfo
		// Props are reactive and updated when user changes device/rotation
		// sessionInfo may be stale (snapshot from launch time)
		const currentDevice: DeviceSize = deviceSize || sessionInfo?.deviceSize || 'laptop';
		const currentRotation: Rotation = rotation || sessionInfo?.rotation || 'landscape';

		// Use getViewportDimensions helper for consistent viewport calculation
		// This ensures portrait = height > width, landscape = width > height
		const { width: canvasWidth, height: canvasHeight } = getViewportDimensions(currentDevice, currentRotation);

		debug.log('webcodecs', `setupCanvasInternal: device=${currentDevice}, rotation=${currentRotation}, canvas=${canvasWidth}x${canvasHeight}`);

		// Get scale from parent (BrowserPreviewContainer calculates this)
		// This is provided via previewDimensions binding
		const currentScale = 1; // We keep canvas at original size, scaling handled by CSS

		if (canvasElement) {
			// Canvas dimensions stay at original viewport size
			// Scaling is handled by CSS transform in parent container
			if (canvasElement.width === canvasWidth && canvasElement.height === canvasHeight) {
				return;
			}

			canvasElement.width = canvasWidth;
			canvasElement.height = canvasHeight;
			canvasElement.style.width = '100%';
			canvasElement.style.height = '100%';
			// Use same background as loading overlay to avoid flash of black
			// This will be covered by overlay until stream is ready anyway
			canvasElement.style.backgroundColor = 'transparent';
			canvasElement.style.cursor = 'default';

			// Get context with low-latency optimizations
			const ctx = canvasElement.getContext('2d', {
				alpha: false, // No transparency needed - faster
				desynchronized: true, // Low latency rendering hint
				willReadFrequently: false // We won't read pixels back
			});

			// Fill with neutral gray (works for both light/dark mode)
			// This matches the loading overlay background roughly
			if (ctx) {
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = 'medium';
				ctx.fillStyle = '#f1f5f9'; // slate-100 - neutral light color
				ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
			}
		}
	}

	function setupCanvas() {
		if (setupCanvasTimeout) {
			clearTimeout(setupCanvasTimeout);
		}
		setupCanvasTimeout = setTimeout(() => {
			setupCanvasInternal();
		}, 5);
	}

	// Start WebCodecs streaming
	async function startStreaming() {
		debug.log('webcodecs', `startStreaming() called: sessionId=${sessionId}, generation=${streamingGeneration}`);

		if (!sessionId || !canvasElement) {
			return;
		}

		// Prevent concurrent start attempts
		if (isStartingStream) {
			debug.log('webcodecs', 'startStreaming() skipped: already starting stream');
			return;
		}

		// If already streaming same session, skip
		if (isWebCodecsActive && activeStreamingSessionId === sessionId) {
			debug.log('webcodecs', 'startStreaming() skipped: already streaming same session');
			return;
		}

		// Capture current generation — if it changes during async operations,
		// it means the user switched tabs and this operation is stale
		const myGeneration = streamingGeneration;

		isStartingStream = true;
		isStreamStarting = true; // Show loading overlay
		// Don't reset if we restored a snapshot - keep showing it
		if (!hasRestoredSnapshot) {
			hasReceivedFirstFrame = false; // Reset first frame state
		}

		try {
			// If streaming a different session, stop first
			if (isWebCodecsActive && activeStreamingSessionId !== sessionId) {
				debug.log('webcodecs', `Session mismatch (active: ${activeStreamingSessionId}, requested: ${sessionId}), stopping old stream first`);
				await stopStreaming();
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			// Bail out if tab switched during cleanup
			if (myGeneration !== streamingGeneration) {
				debug.log('webcodecs', `Stale startStreaming (gen ${myGeneration} != ${streamingGeneration}), aborting`);
				return;
			}

			// Create WebCodecs service if not exists
			if (!webCodecsService) {
				if (!projectId) {
					debug.error('webcodecs', 'Cannot start streaming: projectId is required');
					isStartingStream = false;
					return;
				}
				webCodecsService = new BrowserWebCodecsService(projectId);

				// Setup error handler
				webCodecsService.setErrorHandler((error: Error) => {
					debug.error('webcodecs', 'Error:', error);
					// NOTE: do NOT reset isStartingStream here.
					// This handler fires from inside webCodecsService.startStreaming (before it returns false).
					// Canvas.svelte's startStreaming retry loop is still running with isStartingStream=true.
					// Resetting it here releases the concurrency guard prematurely, causing multiple
					// concurrent streaming sessions to start (each triggering the streaming $effect).
					connectionFailed = true;
				});

				// Setup connection change handler
				webCodecsService.setConnectionChangeHandler((connected: boolean) => {
					isWebCodecsActive = connected;
					isConnected = connected;
					if (!connected) {
						activeStreamingSessionId = null;
					}
				});

				// Setup connection FAILED handler - this triggers recovery
				// Only called on actual failures (ICE failed, connection failed)
				// NOT called on timeouts or slow loading
				webCodecsService.setConnectionFailedHandler(() => {
					debug.warn('webcodecs', 'Connection failed - attempting recovery');
					connectionFailed = true;
					attemptRecovery();
				});

				// Setup navigation reconnect handler - FAST path without delay
				// Called when DataChannel closes during navigation, backend already restarted
				webCodecsService.setNavigationReconnectHandler(() => {
					debug.log('webcodecs', '🚀 Navigation reconnect - fast path (no delay)');
					fastReconnect();
				});

				// Setup reconnecting start handler - fires IMMEDIATELY when DataChannel closes during navigation
				// This ensures isReconnecting is set before the 700ms delay, keeping progress bar visible
				webCodecsService.setReconnectingStartHandler(() => {
					debug.log('webcodecs', '🔄 Reconnecting state started (immediate)');
					isReconnecting = true;
				});

				// Setup stats handler
				webCodecsService.setStatsHandler((stats: BrowserWebCodecsStreamStats) => {
					onStatsUpdate(stats);
				});

				// Setup first frame handler - fires immediately when first frame decoded
				// This eliminates the 500ms polling delay for hiding the loading overlay
				webCodecsService.setFirstFrameHandler(() => {
					if (!hasReceivedFirstFrame) {
						debug.log('webcodecs', 'First frame callback - immediately updating UI');
						hasReceivedFirstFrame = true;
						consecutiveFailures = 0;
						connectionFailed = false;
					}

					// Always reset reconnecting state on first real frame
					// (outside !hasReceivedFirstFrame to handle snapshot + reconnect case)
					if (isReconnecting) {
						setTimeout(() => {
							isReconnecting = false;
						}, 300);
					}

					// Reset navigation state when first frame arrives after navigation.
					// The preview:browser-navigation event that normally resets this can be
					// missed during stream reconnect (listeners are removed/re-registered),
					// so use the first rendered frame as definitive signal that navigation completed.
					if (isNavigating) {
						isNavigating = false;
					}
				});

				// Setup cursor change handler
				webCodecsService.setOnCursorChange((cursor: string) => {
					updateCanvasCursor(cursor);
				});
			}

			// Start streaming with retry for session not ready cases
			debug.log('webcodecs', `Starting streaming for session: ${sessionId}`);

			let success = false;
			let retries = 0;
			const maxRetries = 5;
			const retryDelay = 300;

			while (!success && retries < maxRetries) {
				// Check generation before each attempt
				if (myGeneration !== streamingGeneration) {
					debug.log('webcodecs', `Stale startStreaming retry (gen ${myGeneration} != ${streamingGeneration}), aborting`);
					break;
				}

				try {
					// Guard: webCodecsService can be destroyed by a concurrent tab/project switch
					if (!webCodecsService) {
						debug.warn('webcodecs', 'webCodecsService became null during startStreaming, aborting');
						break;
					}

					success = await webCodecsService.startStreaming(sessionId, canvasElement);

					// Check generation after async operation
					if (myGeneration !== streamingGeneration) {
						debug.log('webcodecs', `Tab switched during startStreaming (gen ${myGeneration} != ${streamingGeneration}), discarding result`);
						if (success && webCodecsService) {
							await webCodecsService.stopStreaming();
						}
						break;
					}

					if (success) {
						isWebCodecsActive = true;
						isConnected = true;
						activeStreamingSessionId = sessionId;
						consecutiveFailures = 0;
						startHealthCheck(hasRestoredSnapshot);
						hasRestoredSnapshot = false;
						debug.log('webcodecs', 'Streaming started successfully');
					} else {
						retries++;
						if (retries < maxRetries) {
							debug.warn('webcodecs', `Streaming start returned false, retrying in ${retryDelay * retries}ms (${retries}/${maxRetries})`);
							await new Promise(resolve => setTimeout(resolve, retryDelay * retries));
							continue;
						}
						debug.error('webcodecs', 'Streaming start failed after all retries');
						break;
					}
					break;
				} catch (error: any) {
					const isRetriable = error?.message?.includes('not found') ||
						error?.message?.includes('invalid') ||
						error?.message?.includes('Failed to start') ||
						error?.message?.includes('No offer');

					if (isRetriable) {
						retries++;
						if (retries < maxRetries) {
							debug.log('webcodecs', `Streaming not ready, retrying in ${retryDelay}ms (${retries}/${maxRetries})`);
							await new Promise(resolve => setTimeout(resolve, retryDelay));
						} else {
							debug.error('webcodecs', 'Max retries reached, streaming still not ready');
							break;
						}
					} else {
						debug.error('webcodecs', 'Streaming error:', error);
						break;
					}
				}
			}
		} finally {
			isStartingStream = false;
			isStreamStarting = false; // Hide "Launching browser..." (but may still show "Connecting..." until first frame)
			hasRestoredSnapshot = false; // Always reset in finally
		}
	}

	// Clear canvas to prevent showing stale frames
	// Use light neutral color that works with loading overlay
	function clearCanvas() {
		if (canvasElement) {
			const ctx = canvasElement.getContext('2d');
			if (ctx) {
				ctx.fillStyle = '#f1f5f9'; // slate-100 - same as setup, works with overlay
				ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
			}
		}
	}

	// EVENT-DRIVEN health check - no timeout-based recovery
	// We only check for first frame to update UI, not to trigger recovery
	// Recovery is triggered by actual connection failures (ICE failed, connection closed)
	// skipFirstFrameReset: When true, don't reset hasReceivedFirstFrame (used during fast reconnect to keep overlay stable)
	function startHealthCheck(skipFirstFrameReset = false) {
		// Stop existing intervals without resetting hasReceivedFirstFrame if skipFirstFrameReset is true
		stopHealthCheck(skipFirstFrameReset);
		lastFrameTime = Date.now();
		if (!skipFirstFrameReset) {
			hasReceivedFirstFrame = false;
		}
		connectionFailed = false;
		hasRequestedScreencastRefresh = false; // Reset for new stream
		screencastRefreshCount = 0; // Reset retry counter

		const startTime = Date.now();

		// Check for first frame periodically (for UI update only, NOT recovery)
		initialFrameCheckInterval = setInterval(() => {
			if (!isWebCodecsActive || !sessionId) {
				return;
			}

			const stats = webCodecsService?.getStats();
			const now = Date.now();
			const elapsed = now - startTime;

			// Log connection state periodically for debugging
			if (elapsed > 0 && elapsed % 5000 < FRAME_CHECK_INTERVAL) {
				debug.log('webcodecs', `Status: connected=${stats?.isConnected}, firstFrame=${stats?.firstFrameRendered}, elapsed=${elapsed}ms`);
			}

			// Check if we received the first frame
			if (stats && stats.firstFrameRendered) {
				debug.log('webcodecs', `First frame rendered after ${elapsed}ms`);
				hasReceivedFirstFrame = true;
				lastFrameTime = now;
				consecutiveFailures = 0;
				connectionFailed = false;
				hasRequestedScreencastRefresh = false; // Reset on success
				screencastRefreshCount = 0; // Reset retry counter on success

				// Reset reconnecting state after successful frame reception
				// This completes the fast reconnect cycle
				// Add small delay to allow page to render a bit more before hiding overlay
				if (isReconnecting) {
					debug.log('webcodecs', 'First frame received during reconnect, will reset isReconnecting after delay');
					setTimeout(() => {
						debug.log('webcodecs', 'Resetting isReconnecting after first frame + delay');
						isReconnecting = false;
					}, 300); // 300ms delay to let page render more
				}

				// Stop initial check, start regular health check
				if (initialFrameCheckInterval) {
					clearInterval(initialFrameCheckInterval);
					initialFrameCheckInterval = undefined;
				}
				startRegularHealthCheck();
				return;
			}

			// FAST REFRESH AFTER NAVIGATION: If navigation just completed and we're
			// connected but no frame, trigger refresh quickly (don't wait 5 seconds)
			if (navigationJustCompleted && stats?.isConnected && !stats?.firstFrameRendered && elapsed >= NAVIGATION_FAST_REFRESH_DELAY && !hasRequestedScreencastRefresh) {
				debug.log('webcodecs', `Navigation completed, fast-refreshing screencast (connected but no frame for ${elapsed}ms)`);
				hasRequestedScreencastRefresh = true;
				navigationJustCompleted = false;
				onRequestScreencastRefresh();
				return; // Skip regular stuck check
			}

			// STUCK STREAM DETECTION (FALLBACK): If connected but no first frame for too long,
			// request screencast refresh (hot-swap) to restart CDP screencast.
			// This handles cases where WebRTC is connected but CDP frames aren't flowing.
			// Retries: 1st at 3s (screencast refresh), 2nd at 6s (another refresh), 3rd at 10s (full recovery)
			if (stats?.isConnected && !stats?.firstFrameRendered && !hasRequestedScreencastRefresh) {
				const MAX_SCREENCAST_RETRIES = 2;
				const retryThreshold = STUCK_STREAM_TIMEOUT + (screencastRefreshCount * 3000); // 3s, 6s

				if (elapsed >= retryThreshold && screencastRefreshCount < MAX_SCREENCAST_RETRIES) {
					screencastRefreshCount++;
					debug.warn('webcodecs', `Stream stuck (connected, no frame for ${elapsed}ms), screencast refresh attempt ${screencastRefreshCount}/${MAX_SCREENCAST_RETRIES}`);
					onRequestScreencastRefresh();
				} else if (elapsed >= 10000 && screencastRefreshCount >= MAX_SCREENCAST_RETRIES) {
					// Screencast refreshes didn't help - attempt full recovery
					debug.warn('webcodecs', `Stream still stuck after ${screencastRefreshCount} screencast refreshes (${elapsed}ms), attempting full recovery`);
					hasRequestedScreencastRefresh = true; // Prevent further retries
					attemptRecovery();
				}
			}

		}, FRAME_CHECK_INTERVAL);
	}

	// Regular health check (after first frame received)
	// Only monitors connection health, doesn't trigger timeout-based recovery
	function startRegularHealthCheck() {
		if (healthCheckInterval) return; // Already running

		healthCheckInterval = setInterval(() => {
			if (!isWebCodecsActive || !sessionId) {
				return;
			}

			const stats = webCodecsService?.getStats();
			const now = Date.now();

			// Update last frame time if we're receiving frames
			if (stats && (stats.firstFrameRendered || stats.videoFramesReceived > 0)) {
				lastFrameTime = now;
				consecutiveFailures = 0;
			}

			// NO TIMEOUT-BASED RECOVERY
			// We only log for debugging purposes
			// Recovery is triggered by actual connection state changes (handled in WebCodecs service)

		}, HEALTH_CHECK_INTERVAL);
	}

	// Stop health check intervals
	// skipFirstFrameReset: When true, don't reset hasReceivedFirstFrame (used during navigation reconnect)
	function stopHealthCheck(skipFirstFrameReset = false) {
		if (initialFrameCheckInterval) {
			clearInterval(initialFrameCheckInterval);
			initialFrameCheckInterval = undefined;
		}
		if (healthCheckInterval) {
			clearInterval(healthCheckInterval);
			healthCheckInterval = undefined;
		}
		// Only reset hasReceivedFirstFrame if not skipping (preserves overlay during navigation)
		if (!skipFirstFrameReset) {
			hasReceivedFirstFrame = false;
		}
	}

	// Attempt to recover stuck stream
	async function attemptRecovery() {
		if (isStartingStream || isRecovering) {
			debug.log('webcodecs', 'Recovery skipped - already starting or recovering');
			return;
		}

		const myGeneration = streamingGeneration;
		consecutiveFailures++;
		debug.log('webcodecs', `Recovery attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} for session ${sessionId}`);

		// A burst of failures is a bad moment, not a verdict: back off and let the
		// watchdog re-arm this counter and try again. Returning here used to be
		// terminal — the stream stopped and nothing ever restarted it, which is
		// one of the ways a preview ended up on "Loading preview…" for good.
		if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
			debug.warn('webcodecs', 'Recovery attempts exhausted for now, backing off to the watchdog');
			isRecovering = false;
			await stopStreaming();
			return;
		}

		// Stop and restart streaming
		try {
			isRecovering = true;
			hasReceivedFirstFrame = false;
			await stopStreaming();
			lastStartRequestId = null;
			await new Promise(resolve => setTimeout(resolve, 500));

			// Bail out if tab switched during cleanup
			if (myGeneration !== streamingGeneration) {
				debug.log('webcodecs', 'Recovery aborted - tab switched during cleanup');
				return;
			}

			await startStreaming();
		} catch (error) {
			debug.error('webcodecs', 'Recovery failed:', error);
		} finally {
			isRecovering = false;
		}
	}

	// Fast reconnect after navigation - NO DELAY because backend already restarted
	// Uses reconnectToExistingStream which does NOT tell backend to stop
	async function fastReconnect() {
		if (isStartingStream || isRecovering) {
			debug.log('webcodecs', 'Fast reconnect skipped - already starting or recovering');
			return;
		}

		if (!sessionId || !canvasElement || !webCodecsService) {
			debug.warn('webcodecs', 'Fast reconnect skipped - missing session, canvas, or service');
			return;
		}

		const myGeneration = streamingGeneration;
		debug.log('webcodecs', `🚀 Fast reconnect for session ${sessionId} (gen=${myGeneration})`);

		try {
			isRecovering = true;
			isStartingStream = true;
			isReconnecting = true;

			const success = await webCodecsService.reconnectToExistingStream(sessionId, canvasElement);

			// Bail out if tab switched during reconnect
			if (myGeneration !== streamingGeneration) {
				debug.log('webcodecs', 'Fast reconnect aborted - tab switched');
				return;
			}

			if (success) {
				isWebCodecsActive = true;
				isConnected = true;
				activeStreamingSessionId = sessionId;
				consecutiveFailures = 0;
				startHealthCheck(true);
				debug.log('webcodecs', '✅ Fast reconnect successful');
			} else {
				throw new Error('Reconnect returned false');
			}
		} catch (error) {
			debug.error('webcodecs', 'Fast reconnect failed:', error);
			consecutiveFailures++;
			isStartingStream = false;
			isReconnecting = false;
			if (myGeneration === streamingGeneration) {
				attemptRecovery();
			}
		} finally {
			isRecovering = false;
			isStartingStream = false;
		}
	}

	/**
	 * One watchdog tick. Sees only "is there a picture yet"; see WATCHDOG_* above
	 * for why it deliberately knows nothing about *why* there isn't one.
	 */
	async function watchdogTick() {
		if (!sessionId || !sessionInfo || !canvasElement) return;

		if (hasReceivedFirstFrame) {
			blankSince = 0;
			watchdogRound = 0;
			return;
		}

		// Something is already on its way to a frame — starting a second attempt
		// on top of it is how two streams end up fighting over one canvas. Only
		// these two, and deliberately not `isNavigating`/`isReconnecting`: those
		// are set by the page and can stay true indefinitely, which would hand
		// the stuck state a way to switch the watchdog off.
		if (isStartingStream || isRecovering) {
			blankSince = 0;
			return;
		}

		const now = Date.now();
		if (blankSince === 0) {
			blankSince = now;
			return;
		}

		const patience = Math.min(
			WATCHDOG_FIRST_ESCALATION_MS + watchdogRound * WATCHDOG_ESCALATION_STEP_MS,
			WATCHDOG_MAX_WAIT_MS
		);
		if (now - blankSince < patience) return;

		blankSince = now;
		watchdogRound++;
		// A fresh round gets a fresh allowance, so `attemptRecovery` can never be
		// permanently spent — that is the whole point of the back-off above.
		consecutiveFailures = 0;
		connectionFailed = false;

		const stats = webCodecsService?.getStats();

		// Connected, decoding nothing: the source half is the broken one, and
		// restarting its capture is both cheaper and likelier to work than
		// re-negotiating a connection that is demonstrably fine.
		if (isWebCodecsActive && stats?.isConnected) {
			debug.warn('webcodecs', `Watchdog: connected but blank for ${patience}ms, refreshing capture (round ${watchdogRound})`);
			onRequestScreencastRefresh();
			return;
		}

		debug.warn(
			'webcodecs',
			`Watchdog: no frame after ${patience}ms (connection=${stats?.connectionState ?? 'none'}), re-handshaking (round ${watchdogRound})`
		);
		await attemptRecovery();
	}

	// Runs for as long as a tab has a session, independently of whether a stream
	// was ever successfully started — a failed start is one of the cases this
	// exists to catch.
	$effect(() => {
		if (!sessionId || !sessionInfo) return;

		const timer = setInterval(() => {
			void watchdogTick();
		}, WATCHDOG_TICK_MS);

		return () => clearInterval(timer);
	});

	// Stop WebCodecs streaming
	async function stopStreaming() {
		stopHealthCheck(); // Stop health monitoring
		if (webCodecsService) {
			await webCodecsService.stopStreaming();
			isWebCodecsActive = false;
			isConnected = false;
			latencyMs = 0;
			activeStreamingSessionId = null;
			isStartingStream = false;
			lastStartRequestId = null; // Clear to allow new requests
			// Note: Don't reset hasReceivedFirstFrame here - let startStreaming do it
			// This prevents flashing when switching tabs
			// Clear canvas to prevent stale frames, BUT keep last frame during navigation or snapshot restore
			if (!isNavigating && !hasRestoredSnapshot) {
				clearCanvas();
			} else {
				debug.log('webcodecs', `Skipping canvas clear - navigation: ${isNavigating}, snapshot: ${hasRestoredSnapshot}`);
			}
		}
	}

	// Reactive setup when sessionInfo changes
	$effect(() => {
		if (sessionInfo && canvasElement) {
			setupCanvasInternal();
		}
	});

	// Track deviceSize and rotation changes to update canvas dimensions
	// This is critical for hot-swap viewport changes without reconnection
	$effect(() => {
		if (canvasElement && sessionInfo) {
			// Access reactive values to track changes
			const currentDevice = deviceSize;
			const currentRotation = rotation;

			debug.log('webcodecs', `Device/rotation changed: ${currentDevice}/${currentRotation}, reconfiguring canvas`);
			setupCanvasInternal();
		}
	});

	// Start/restart streaming when session is ready
	// This handles both initial start and session changes (viewport switch, etc.)
	$effect(() => {
		debug.log('webcodecs', `[DIAG] streaming $effect triggered: sessionId=${sessionId}, canvasElement=${!!canvasElement}, sessionInfo=${!!sessionInfo}, isReconnecting=${isReconnecting}, isWebCodecsActive=${isWebCodecsActive}, activeStreamingSessionId=${activeStreamingSessionId}`);

		if (sessionId && canvasElement && sessionInfo) {
			// Skip during fast reconnect - fastReconnect() handles this case
			if (isReconnecting) {
				debug.log('webcodecs', 'Skipping streaming effect - fast reconnect in progress');
				return;
			}

			// Check if we need to start or restart streaming
			const needsStreaming = !isWebCodecsActive || activeStreamingSessionId !== sessionId;
			debug.log('webcodecs', `[DIAG] streaming $effect: needsStreaming=${needsStreaming}`);

			if (needsStreaming) {
				if (activeStreamingSessionId !== sessionId) {
					// SNAPSHOT: Save current canvas before switching to new session
					if (activeStreamingSessionId && hasReceivedFirstFrame && canvasElement.width > 0) {
						try {
							const clone = document.createElement('canvas');
							clone.width = canvasElement.width;
							clone.height = canvasElement.height;
							const cloneCtx = clone.getContext('2d');
							if (cloneCtx) {
								cloneCtx.drawImage(canvasElement, 0, 0);
								// Limit snapshot count
								if (canvasSnapshots.size >= MAX_SNAPSHOTS) {
									const firstKey = canvasSnapshots.keys().next().value;
									if (firstKey) canvasSnapshots.delete(firstKey);
								}
								canvasSnapshots.set(activeStreamingSessionId, clone);
								debug.log('webcodecs', `📸 Saved canvas snapshot for session ${activeStreamingSessionId}`);
							}
						} catch (e) {
							debug.warn('webcodecs', 'Failed to capture canvas snapshot:', e);
						}
					}

					// SNAPSHOT: Restore for new session if available
					const existingSnapshot = canvasSnapshots.get(sessionId);
					if (existingSnapshot) {
						setupCanvasInternal(); // Ensure canvas dimensions are correct
						try {
							const ctx = canvasElement.getContext('2d');
							if (ctx) {
								ctx.drawImage(existingSnapshot, 0, 0, canvasElement.width, canvasElement.height);
								hasRestoredSnapshot = true;
								// Don't reset hasReceivedFirstFrame - snapshot is visible
								debug.log('webcodecs', `📸 Restored canvas snapshot for session ${sessionId}`);
							}
						} catch (e) {
							debug.warn('webcodecs', 'Failed to restore canvas snapshot:', e);
							hasRestoredSnapshot = false;
							clearCanvas();
							hasReceivedFirstFrame = false;
						}
					} else {
						hasRestoredSnapshot = false;
						clearCanvas();
						hasReceivedFirstFrame = false; // Reset to show loading overlay
					}
				}

				// Stop existing streaming first if session changed
				// This ensures clean state before starting new stream
				const capturedGeneration = streamingGeneration;

				// IMMEDIATELY block the old session's frames from painting onto the canvas.
				// Without this, A's DataChannel continues delivering frames for up to 30ms
				// after we clear/snapshot-restore the canvas, overwriting B's content.
				if (activeStreamingSessionId && activeStreamingSessionId !== sessionId) {
					webCodecsService?.pauseRendering();
				}

				const doStartStreaming = async () => {
					// Bail immediately if tab already changed
					if (capturedGeneration !== streamingGeneration) return;

					if (activeStreamingSessionId && activeStreamingSessionId !== sessionId) {
						debug.log('webcodecs', `Session changed from ${activeStreamingSessionId} to ${sessionId}, stopping old stream first`);
						await stopStreaming();
						// Bail if tab changed during cleanup
						if (capturedGeneration !== streamingGeneration) return;
						// Short wait for backend cleanup
						await new Promise(resolve => setTimeout(resolve, 50));
						if (capturedGeneration !== streamingGeneration) return;
					}
					await startStreaming();
				};

				// Small delay to ensure backend session is ready
				const timeout = setTimeout(() => {
					doStartStreaming();
				}, 30);

				return () => clearTimeout(timeout);
			}
		}
	});

	// Cleanup when sessionId is cleared
	$effect(() => {
		if (!sessionId && isWebCodecsActive) {
			hasReceivedFirstFrame = false; // Reset loading state
			stopStreaming();
		}
	});

	// Setup event listeners when canvas is ready
	$effect(() => {
		if (canvasElement) {
			const canvas = canvasElement;

			canvas.addEventListener('dblclick', (e) => handleCanvasDoubleClick(e, canvas));
			canvas.addEventListener('contextmenu', (e) => handleCanvasRightClick(e, canvas));
			canvas.addEventListener('wheel', (e) => handleCanvasWheel(e, canvas), { passive: false });
			canvas.addEventListener('keydown', handleCanvasKeydown);
			canvas.addEventListener('mousedown', (e) => handleCanvasMouseDown(e, canvas));
			canvas.addEventListener('mouseup', (e) => handleCanvasMouseUp(e, canvas));

			let lastMoveTime = 0;
			const handleMouseMove = (e: MouseEvent) => {
				const now = Date.now();
				// The move that begins a drag is never throttled: it is the one that
				// dispatches the deferred mousedown, so delaying it by up to a frame
				// delays the whole selection with it.
				const startsDrag = isMouseDown && !dragStarted;
				// 32ms = ~30fps — enough for smooth hover/drag while keeping CDP pipeline clear
				// for clicks and keypresses (halving the rate halves CDP queue pressure)
				if (startsDrag || now - lastMoveTime >= 32) {
					lastMoveTime = now;
					handleCanvasMouseMove(e, canvas);
				}
			};
			canvas.addEventListener('mousemove', handleMouseMove);

			canvas.addEventListener('mousedown', () => {
				canvas.focus();
			});


			const handleMouseLeave = () => {
				if (isMouseDown) {
					// If drag was started, send mouseup before resetting
					if (dragStarted) {
						sendInteraction({
							type: 'mouseup',
							x: dragCurrentPos?.x || dragStartPos?.x || 0,
							y: dragCurrentPos?.y || dragStartPos?.y || 0,
							button: 'left'
						});
					}
					isMouseDown = false;
					isDragging = false;
					dragStartPos = null;
					dragCurrentPos = null;
					dragStarted = false;
				}
			};
			canvas.addEventListener('mouseleave', handleMouseLeave);

			return () => {
				canvas.removeEventListener('dblclick', (e) => handleCanvasDoubleClick(e, canvas));
				canvas.removeEventListener('contextmenu', (e) => handleCanvasRightClick(e, canvas));
				canvas.removeEventListener('wheel', (e) => handleCanvasWheel(e, canvas));
				canvas.removeEventListener('keydown', handleCanvasKeydown);
				canvas.removeEventListener('mousedown', (e) => handleCanvasMouseDown(e, canvas));
				canvas.removeEventListener('mouseup', (e) => handleCanvasMouseUp(e, canvas));
				canvas.removeEventListener('mousemove', handleMouseMove);
			};
		}
	});

	// Attach touch events to touchTarget (Container's previewContainer) instead of canvas
	$effect(() => {
		if (!touchTarget || !canvasElement) return;

		const canvas = canvasElement;
		let lastTouchMoveTime = 0;

		const touchStartHandler = (e: TouchEvent) => handleTouchStart(e, canvas);
		const touchMoveHandler = (e: TouchEvent) => {
			const now = Date.now();
			if (now - lastTouchMoveTime >= 16) {
				lastTouchMoveTime = now;
				handleTouchMove(e, canvas);
			}
		};
		const touchEndHandler = (e: TouchEvent) => handleTouchEnd(e, canvas);

		touchTarget.addEventListener('touchstart', touchStartHandler, { passive: false });
		touchTarget.addEventListener('touchmove', touchMoveHandler, { passive: false });
		touchTarget.addEventListener('touchend', touchEndHandler, { passive: false });
		// The OS can take a gesture away mid-flight (a system edge swipe, an
		// incoming call). Without this the tracked finger is never released and
		// the next touch reads as a continuation of the interrupted one.
		touchTarget.addEventListener('touchcancel', touchEndHandler, { passive: false });

		return () => {
			touchTarget.removeEventListener('touchstart', touchStartHandler);
			touchTarget.removeEventListener('touchmove', touchMoveHandler);
			touchTarget.removeEventListener('touchend', touchEndHandler);
			touchTarget.removeEventListener('touchcancel', touchEndHandler);
		};
	});

	/**
	 * Page → screen. Null when the canvas has no geometry yet (mid-mount, panel
	 * collapsed), which callers must treat as "cannot place this" — an overlay
	 * that falls back to the origin lands in the corner of the window, nowhere
	 * near the element it belongs to.
	 */
	function pageToScreen(cx: number, cy: number): { x: number; y: number } | null {
		if (!canvasElement) return null;
		// Painted rect, not element box — see paintedRect(). Using the box put the
		// virtual cursor off by the letterbox bars.
		const rect = paintedRect(canvasElement);
		if (!rect) return null;
		return {
			x: rect.left + cx * (rect.width / pageSize.width),
			y: rect.top + cy * (rect.height / pageSize.height)
		};
	}

	// Convert page coordinates to viewport (screen) coordinates for VirtualCursor display
	function canvasToScreen(cx: number, cy: number): { x: number; y: number } {
		return pageToScreen(cx, cy) ?? { x: 0, y: 0 };
	}

	// Keep the virtual cursor inside the page when the viewport changes.
	// Rotating to portrait or switching to a phone shrinks the page under the
	// cursor, which would otherwise be left pointing past its edge.
	$effect(() => {
		void deviceSize;
		void rotation;
		if (!canvasElement) return;

		trackpadCursorX = Math.max(0, Math.min(pageSize.width, trackpadCursorX));
		trackpadCursorY = Math.max(0, Math.min(pageSize.height, trackpadCursorY));
	});

	// Show / hide cursor when touchMode changes
	$effect(() => {
		if (touchMode === 'cursor') {
			// Init cursor at page centre on first activation
			if (canvasElement && trackpadCursorX === 0 && trackpadCursorY === 0) {
				trackpadCursorX = pageSize.width / 2;
				trackpadCursorY = pageSize.height / 2;
			}
			if (canvasElement) {
				const pos = canvasToScreen(trackpadCursorX, trackpadCursorY);
				onTouchCursorUpdate({ x: pos.x, y: pos.y, visible: true });
			}
		} else {
			onTouchCursorUpdate({ x: 0, y: 0, visible: false });
		}
	});

	// ── Trackpad (cursor) mode handlers ───────────────────────────────────────

	function handleTrackpadTouchStart(event: TouchEvent) {
		if (event.touches.length >= 2) {
			// Second finger joined → switch to two-finger mode
			if (!trackpadTwoFingerActive) {
				// Cancel any pending single-finger actions
				if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
				if (touchLongPressed && dragStarted) {
					sendInteraction({ type: 'mouseup', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
				}
				isMouseDown = false;
				dragStarted = false;
				touchLongPressed = false;
				publishTouchCursor();
			}
			trackpadTwoFingerActive = true;
			trackpadGestureSettled = false;
			trackpadTwoFingerStartTime = Date.now();
			trackpadTwoFingerTotalDist = 0;
			const t1 = event.touches[0];
			const t2 = event.touches[1];
			trackpadTwoFingerLastCenterX = (t1.clientX + t2.clientX) / 2;
			trackpadTwoFingerLastCenterY = (t1.clientY + t2.clientY) / 2;
			return;
		}

		// Ignore anything that arrives before the glass is clear: a finger put
		// back down while the tail of a two-finger gesture is still lifting is
		// part of that gesture, not the start of a tap.
		if (trackpadTwoFingerActive || trackpadGestureSettled) return;

		// Single finger
		const touch = event.touches[0];
		trackpadTouchStartClientX = touch.clientX;
		trackpadTouchStartClientY = touch.clientY;
		trackpadLastClientX = touch.clientX;
		trackpadLastClientY = touch.clientY;
		isMouseDown = true;
		mouseDownTime = Date.now();
		dragStarted = false;
		touchLongPressed = false;
		trackpadDoubleTapArmed = mouseDownTime - trackpadLastTapAt < DOUBLE_TAP_WINDOW_MS;

		// The tap lands at the virtual cursor, not the finger — probe there.
		beginKeyboardProbe({ x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });

		// Long-press (600ms without movement) → drag mode
		longPressTimer = setTimeout(() => {
			if (!isMouseDown) return;
			const dist = Math.sqrt(
				Math.pow(trackpadLastClientX - trackpadTouchStartClientX, 2) +
				Math.pow(trackpadLastClientY - trackpadTouchStartClientY, 2)
			);
			if (dist < 8) {
				touchLongPressed = true;
				dragStarted = true;
				cancelKeyboardProbe();
				sendInteraction({ type: 'mousedown', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
				// Held, not tapped: the cursor shows the button down for as long
				// as the drag lasts, the way the agent's does.
				publishTouchCursor({ pressed: true });
			}
		}, 600);
	}

	function handleTrackpadTouchMove(event: TouchEvent) {
		if (!canvasElement) return;

		if (event.touches.length >= 2 && trackpadTwoFingerActive) {
			// Two-finger scroll
			const t1 = event.touches[0];
			const t2 = event.touches[1];
			const centerX = (t1.clientX + t2.clientX) / 2;
			const centerY = (t1.clientY + t2.clientY) / 2;
			const deltaX = trackpadTwoFingerLastCenterX - centerX;
			const deltaY = trackpadTwoFingerLastCenterY - centerY;
			trackpadTwoFingerLastCenterX = centerX;
			trackpadTwoFingerLastCenterY = centerY;
			trackpadTwoFingerTotalDist += Math.sqrt(deltaX * deltaX + deltaY * deltaY);
			if (Math.abs(deltaX) > 0.3 || Math.abs(deltaY) > 0.3) {
				const scale = pageScale(canvasElement);
				// Scroll at the virtual cursor, so two-finger scrolling affects
				// whichever container the cursor is hovering.
				sendInteraction({
					type: 'scroll',
					deltaX: deltaX * scale * 2,
					deltaY: deltaY * scale * 2,
					x: Math.round(trackpadCursorX),
					y: Math.round(trackpadCursorY)
				});
			}
			return;
		}

		if (event.touches.length !== 1 || !isMouseDown || trackpadTwoFingerActive || trackpadGestureSettled) return;

		const touch = event.touches[0];
		const deltaClientX = touch.clientX - trackpadLastClientX;
		const deltaClientY = touch.clientY - trackpadLastClientY;
		trackpadLastClientX = touch.clientX;
		trackpadLastClientY = touch.clientY;

		// Cancel long-press if finger moved significantly
		const totalDist = Math.sqrt(
			Math.pow(touch.clientX - trackpadTouchStartClientX, 2) +
			Math.pow(touch.clientY - trackpadTouchStartClientY, 2)
		);
		if (totalDist > 8) {
			if (longPressTimer) {
				clearTimeout(longPressTimer);
				longPressTimer = null;
			}
			// Moving the cursor is not a tap; the probed point is no longer where
			// the gesture will land.
			cancelKeyboardProbe();

			// The second tap of a double-tap moved: that is a drag, and it starts
			// from where the cursor already is rather than waiting out a press.
			if (trackpadDoubleTapArmed && !dragStarted) {
				trackpadDoubleTapArmed = false;
				touchLongPressed = true;
				dragStarted = true;
				sendInteraction({ type: 'mousedown', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
			}
		}

		// Convert screen delta → page delta and move cursor
		const scale = pageScale(canvasElement);
		trackpadCursorX = Math.max(0, Math.min(pageSize.width, trackpadCursorX + deltaClientX * scale));
		trackpadCursorY = Math.max(0, Math.min(pageSize.height, trackpadCursorY + deltaClientY * scale));

		// Send mousemove so the browser sees hover state changes
		sendInteraction({ type: 'mousemove', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });

		// Update virtual cursor display — held while a long-press drag is running.
		publishTouchCursor({ pressed: dragStarted });
	}

	function handleTrackpadTouchEnd(event: TouchEvent) {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

		const remainingTouches = event.touches.length;
		// The OS took the gesture away — it was never completed, so nothing it
		// might have meant should be dispatched.
		const cancelled = event.type === 'touchcancel';

		if (trackpadTwoFingerActive) {
			// Decided here, on the *first* lift, because that is the last moment
			// the gesture is still recognisable — a two-finger tap only ever
			// reaches this branch, never the all-fingers-up one.
			const duration = Date.now() - trackpadTwoFingerStartTime;
			if (!cancelled && duration < 400 && trackpadTwoFingerTotalDist < 24) {
				sendInteraction({ type: 'rightclick', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });
				pulseTouchCursor();
			}

			trackpadTwoFingerActive = false;
			// Whatever is still touching belongs to the gesture just finished.
			trackpadGestureSettled = remainingTouches > 0;
			isMouseDown = false;
			dragStarted = false;
			touchLongPressed = false;
			return;
		}

		if (trackpadGestureSettled) {
			// Tail of a two-finger gesture. Clear once the glass is.
			if (remainingTouches === 0) trackpadGestureSettled = false;
			return;
		}

		if (!isMouseDown) return;

		if (touchLongPressed && dragStarted) {
			sendInteraction({ type: 'mouseup', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
			pulseTouchCursor();
		} else {
			// Tap: short + minimal movement → left click at cursor position
			const duration = Date.now() - mouseDownTime;
			const moveDist = Math.sqrt(
				Math.pow(trackpadLastClientX - trackpadTouchStartClientX, 2) +
				Math.pow(trackpadLastClientY - trackpadTouchStartClientY, 2)
			);
			if (!cancelled && duration < 250 && moveDist < 10) {
				const anchor = { x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) };
				// A second tap that never moved is a double-click, not two clicks:
				// sending a bare click again would not select a word or open what
				// a double-click opens.
				sendInteraction({
					type: trackpadDoubleTapArmed ? 'doubleclick' : 'click',
					x: anchor.x,
					y: anchor.y
				});
				settleKeyboard(anchor);
				pulseTouchCursor();
				// A completed double-click closes the sequence; a third tap in a
				// row should start over rather than count as another pair.
				trackpadLastTapAt = trackpadDoubleTapArmed ? 0 : Date.now();
			} else {
				cancelKeyboardProbe();
				publishTouchCursor();
			}
		}

		isMouseDown = false;
		dragStarted = false;
		touchLongPressed = false;
		trackpadDoubleTapArmed = false;
	}

	// ── Touch event handlers (dispatch to scroll or trackpad mode) ────────────

	// Touch event handlers
	function handleTouchStart(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0) return;

		if (touchMode === 'cursor') {
			// Trackpad mode treats the whole panel as a surface, so a touch that
			// starts on the bezel is legitimate.
			event.preventDefault();
			handleTrackpadTouchStart(event);
			return;
		}

		// ── Direct-touch mode ───────────────────────────────────────────────────
		if (event.touches.length > 1) return;

		const touch = event.touches[0];
		const coords = toPageCoordinates(touch.clientX, touch.clientY, canvas);

		// Gestures that begin off the page belong to the panel, not the page —
		// forwarding them is what made scrolling register a pointer somewhere else.
		if (!coords.inside) {
			activeTouchId = null;
			return;
		}

		event.preventDefault();

		activeTouchId = touch.identifier;
		isMouseDown = true;
		mouseDownTime = Date.now();
		dragStartPos = { x: coords.x, y: coords.y };
		dragCurrentPos = { x: coords.x, y: coords.y };
		dragStarted = false;
		touchLongPressed = false;
		lastTouchCoords = { x: coords.x, y: coords.y };

		// Ask what is under the finger now, while the tap is still happening.
		beginKeyboardProbe({ x: coords.x, y: coords.y });

		// Long-press opens the context menu, as it does in every mobile browser.
		// Mouse-style press-and-drag lives in the trackpad mode instead — here the
		// same gesture is how the page is scrolled, so it cannot mean both.
		longPressTimer = setTimeout(() => {
			if (!isMouseDown || !dragStartPos) return;
			const dist = dragCurrentPos
				? Math.sqrt(
						Math.pow(dragCurrentPos.x - dragStartPos.x, 2) +
						Math.pow(dragCurrentPos.y - dragStartPos.y, 2)
					)
				: 0;
			if (dist < 10) {
				touchLongPressed = true;
				cancelKeyboardProbe();
				sendInteraction({ type: 'rightclick', x: dragStartPos.x, y: dragStartPos.y });
				// A short buzz confirms the menu is coming, matching the platform.
				navigator.vibrate?.(10);
			}
		}, 500);
	}

	function handleTouchMove(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0) return;

		if (touchMode === 'cursor') {
			event.preventDefault();
			handleTrackpadTouchMove(event);
			return;
		}

		// ── Direct-touch mode ───────────────────────────────────────────────────
		if (!isMouseDown || !dragStartPos) return;

		const touch = findTouch(event, activeTouchId);
		if (!touch) return;

		event.preventDefault();

		const coords = toPageCoordinates(touch.clientX, touch.clientY, canvas);
		dragCurrentPos = { x: coords.x, y: coords.y };

		const dist = Math.sqrt(
			Math.pow(coords.x - dragStartPos.x, 2) + Math.pow(coords.y - dragStartPos.y, 2)
		);

		if (dist > 10) {
			if (longPressTimer) {
				clearTimeout(longPressTimer);
				longPressTimer = null;
			}
			// The gesture is a scroll now. Scrolling in a mobile browser leaves the
			// keyboard exactly as it was, so the pending answer must not act.
			cancelKeyboardProbe();
		}

		if (touchLongPressed) {
			// The context menu owns this gesture now; further movement must not
			// scroll the page out from under it.
		} else {
			if (lastTouchCoords) {
				const deltaX = lastTouchCoords.x - coords.x;
				const deltaY = lastTouchCoords.y - coords.y;
				// Coordinates travel with the wheel: CDP dispatches it at the
				// pointer, and a touch scroll has no pointer of its own to place.
				sendInteraction({ type: 'scroll', deltaX, deltaY, x: coords.x, y: coords.y });
			}
			lastTouchCoords = { x: coords.x, y: coords.y };
		}
	}

	function handleTouchEnd(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;

		if (touchMode === 'cursor') {
			event.preventDefault();
			handleTrackpadTouchEnd(event);
			return;
		}

		// ── Direct-touch mode ───────────────────────────────────────────────────
		if (!isMouseDown) return;

		event.preventDefault();

		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

		if (touchLongPressed) {
			// Already handled as a context-menu open on the press itself.
		} else if (!isDragging && dragStartPos) {
			const touchDuration = Date.now() - mouseDownTime;
			const dist = dragCurrentPos
				? Math.sqrt(
						Math.pow(dragCurrentPos.x - dragStartPos.x, 2) +
						Math.pow(dragCurrentPos.y - dragStartPos.y, 2)
					)
				: 0;
			if (touchDuration < 300 && dist < 15) {
				const anchor = { x: dragStartPos.x, y: dragStartPos.y };
				sendInteraction({ type: 'click', x: anchor.x, y: anchor.y });
				settleKeyboard(anchor);
			} else {
				cancelKeyboardProbe();
			}
		}

		isMouseDown = false;
		isDragging = false;
		dragStartPos = null;
		dragCurrentPos = null;
		dragStarted = false;
		touchLongPressed = false;
		lastTouchCoords = null;
		activeTouchId = null;
	}

	// ── On-screen keyboard bridge (touch devices) ─────────────────────────────
	//
	// A `<canvas>` can hold DOM focus but will never raise a mobile keyboard —
	// only a real editable element does. So a hidden field sits over the canvas,
	// takes the keyboard, and its text is forwarded to the page as keystrokes.
	//
	// Text is diffed rather than intercepted per key: Android IMEs (GBoard,
	// autocorrect, swipe input) do not emit meaningful `keydown` events, and
	// preventing the default on `beforeinput` breaks composition outright.

	let keyboardInput = $state<HTMLTextAreaElement | undefined>();
	let keyboardValue = '';
	let isKeyboardActive = $state(false);
	let keyboardConfirmToken = 0;
	let keyboardInputMode = $state<'text' | 'email' | 'tel' | 'url' | 'decimal' | 'search'>('text');

	/**
	 * Where the keyboard proxy sits, in page coordinates.
	 *
	 * It follows the tap rather than covering the canvas: a full-size focused
	 * field makes the browser scroll toward it and resize the visual viewport,
	 * which is what produced the white flashes and the empty band above the
	 * preview. A 1px target at the point already being touched has nowhere to
	 * scroll to.
	 */
	let keyboardAnchor = $state({ x: 0, y: 0 });

	/**
	 * Focus the hidden field.
	 *
	 * Must run synchronously inside the touch handler wherever possible: iOS only
	 * raises the keyboard for a programmatic focus that happens while the user
	 * gesture is still active, and an `await` in between forfeits that.
	 */
	function captureKeyboard(anchor?: { x: number; y: number }) {
		if (!keyboardInput || !isTouchDevice) return;

		if (anchor) keyboardAnchor = anchor;
		keyboardValue = '';
		keyboardInput.value = '';
		keyboardInput.focus({ preventScroll: true });
		isKeyboardActive = true;
	}

	/**
	 * The hit test for the gesture currently under way.
	 *
	 * Started on `touchstart` so its answer is usually in hand by `touchend` —
	 * the tap is the slow part, not the round-trip. A stale answer from an
	 * earlier gesture must never act on the newest one, hence the token.
	 */
	let pendingHitTest: {
		token: number;
		result: RemoteFocusState | null;
		promise: Promise<RemoteFocusState>;
	} | null = null;

	function beginKeyboardProbe(anchor: { x: number; y: number }) {
		if (!isTouchDevice) return;

		keyboardConfirmToken += 1;
		const token = keyboardConfirmToken;

		const entry: { token: number; result: RemoteFocusState | null; promise: Promise<RemoteFocusState> } = {
			token,
			result: null,
			promise: probeHitTest(anchor.x, anchor.y).then((state) => {
				if (keyboardConfirmToken === token) entry.result = state;
				return state;
			})
		};

		pendingHitTest = entry;
	}

	/**
	 * Abandon the gesture's keyboard decision — it turned into a scroll or a
	 * long-press, neither of which should disturb an open keyboard.
	 */
	function cancelKeyboardProbe() {
		keyboardConfirmToken += 1;
		pendingHitTest = null;
	}

	/**
	 * Phone keyboards specialise by input type — a numeric pad for `tel`, an
	 * `@` key for `email`. The proxy is what the OS actually sees, so the type
	 * has to be carried across to it or every field gets a plain alphabetic one.
	 */
	function inputModeFor(inputType?: string): 'text' | 'email' | 'tel' | 'url' | 'decimal' | 'search' {
		switch (inputType) {
			case 'email':
				return 'email';
			case 'tel':
				return 'tel';
			case 'url':
				return 'url';
			case 'number':
				return 'decimal';
			case 'search':
				return 'search';
			default:
				return 'text';
		}
	}

	function applyKeyboardTarget(state: RemoteFocusState, anchor: { x: number; y: number }) {
		if (state.editable) {
			keyboardInputMode = inputModeFor(state.inputType);
			captureKeyboard(anchor);
		} else if (isKeyboardActive) {
			releaseKeyboard();
		}
	}

	/**
	 * Settle the keyboard for the tap that just finished.
	 *
	 * The fast path is synchronous, which is the whole point of probing early.
	 * When the answer is still in flight — a slow link, a busy page — it is
	 * applied on arrival instead: Android raises the keyboard from that just
	 * fine, and on iOS the toolbar's keyboard button covers the gap.
	 */
	function settleKeyboard(anchor: { x: number; y: number }) {
		if (!isTouchDevice) return;

		const entry = pendingHitTest;
		if (entry && entry.token === keyboardConfirmToken && entry.result) {
			applyKeyboardTarget(entry.result, anchor);
			return;
		}

		const token = entry?.token ?? ++keyboardConfirmToken;
		const answer = entry?.promise ?? probeHitTest(anchor.x, anchor.y);
		void answer.then((state) => {
			if (token !== keyboardConfirmToken) return;
			applyKeyboardTarget(state, anchor);
		});
	}

	function releaseKeyboard() {
		isKeyboardActive = false;
		keyboardValue = '';
		if (keyboardInput) {
			keyboardInput.value = '';
			keyboardInput.blur();
		}
	}

	/**
	 * Turn the hidden field's new contents into keystrokes for the page.
	 *
	 * Only the common-prefix delta is sent, so an IME that rewrites the tail of
	 * a word replaces exactly that tail.
	 */
	function handleKeyboardInput() {
		if (!keyboardInput || !sessionId) return;

		const next = keyboardInput.value;
		const previous = keyboardValue;
		if (next === previous) return;

		let shared = 0;
		while (shared < next.length && shared < previous.length && next[shared] === previous[shared]) {
			shared += 1;
		}

		const deletions = previous.length - shared;
		for (let i = 0; i < deletions; i += 1) {
			sendInteraction({ type: 'key', key: 'Backspace' });
		}

		const inserted = next.slice(shared);
		if (inserted) {
			sendInteraction({ type: 'type', text: inserted, delay: 0 });
		}

		keyboardValue = next;

		// The mirror only exists to diff against; letting it grow unbounded would
		// keep an ever-longer string in a field the user cannot see.
		if (next.length > 512) {
			keyboardValue = '';
			keyboardInput.value = '';
		}
	}

	function handleKeyboardKeydown(event: KeyboardEvent) {
		if (!sessionId) return;

		if (event.key === 'Enter') {
			event.preventDefault();
			sendInteraction({ type: 'keynav', key: 'Enter' });
			keyboardValue = '';
			if (keyboardInput) keyboardInput.value = '';
			return;
		}

		// Backspace at the start of the mirror has nothing to delete locally, so
		// `input` never fires — forward it directly.
		if (event.key === 'Backspace' && keyboardValue.length === 0) {
			event.preventDefault();
			sendInteraction({ type: 'key', key: 'Backspace' });
			return;
		}

		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape'].includes(event.key)) {
			event.preventDefault();
			sendInteraction({
				type: 'keynav',
				key: event.key,
				shiftKey: event.shiftKey
			});
		}
	}

	function getCanvasElement() {
		return canvasElement;
	}

	// Notify canvas that navigation has completed
	// This triggers fast reconnection if connection was lost during navigation
	async function notifyNavigationComplete() {
		debug.log('webcodecs', 'Navigation complete notification received');
		navigationJustCompleted = true;

		// If connection was lost during navigation, trigger fast reconnection
		// Backend has already restarted streaming, just need to reconnect frontend
		if (webCodecsService && !webCodecsService.getConnectionStatus() && sessionId) {
			debug.log('webcodecs', 'Connection lost during navigation - triggering fast reconnection');

			// Reset navigation state to allow normal error handling after reconnect
			webCodecsService.setNavigating(false);

			// Small delay to ensure backend has restarted streaming
			await new Promise(resolve => setTimeout(resolve, 200));

			// Restart streaming (this will reconnect to the new peer)
			lastStartRequestId = null; // Clear to allow new start request
			await startStreaming();
		}
	}

	// Expose API methods to parent component
	$effect(() => {
		canvasAPI = {
			updateCanvasCursor,
			setupCanvas,
			getCanvasElement,
			/** Where the frame is actually painted — overlays anchor to this. */
			getPaintedRect: () => (canvasElement ? paintedRect(canvasElement) : null),
			/**
			 * Page → screen, the inverse of what pointer events go through.
			 * Shared so overlays the page positions itself (select popups, context
			 * menus, native pickers, the agent's cursor) cannot drift away from the
			 * point the user actually clicked.
			 */
			pageToScreen: (x: number, y: number) => pageToScreen(x, y),
			getPageSize: () => ({ width: pageSize.width, height: pageSize.height }),
			/**
			 * Report new display metrics without restarting capture.
			 *
			 * Goes through the streaming service rather than straight to the
			 * socket: the source tracks these per viewer now, and only the
			 * service knows which viewer this is.
			 */
			sendDisplayMetrics: () => webCodecsService?.sendDisplayMetrics(),
			// Streaming control
			startStreaming,
			stopStreaming,
			isActive: () => isWebCodecsActive,
			getStats: () => webCodecsService?.getStats() ?? null,
			getLatency: () => latencyMs,
			// Navigation handling
			notifyNavigationComplete,
			freezeForSpaNavigation: () => webCodecsService?.freezeForSpaNavigation(),
			// On-screen keyboard control, for the toolbar's explicit toggle
			supportsKeyboardToggle: () => isTouchDevice,
			isKeyboardActive: () => isKeyboardActive,
			openKeyboard: () => captureKeyboard(),
			closeKeyboard: releaseKeyboard
		};
	});

	onDestroy(() => {
		stopHealthCheck(); // Stop health monitoring
		canvasSnapshots.clear(); // Free snapshot memory
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		if (webCodecsService) {
			webCodecsService.destroy();
			webCodecsService = null;
		}
		activeStreamingSessionId = null;
		isStartingStream = false;
		lastStartRequestId = null;
	});
</script>

<!-- Canvas - loading overlay is handled by parent PreviewContainer -->
<canvas
	bind:this={canvasElement}
	class="w-full h-full object-contain"
	tabindex="0"
	style="cursor: default;"
></canvas>

{#if isTouchDevice}
	<!--
		Keyboard proxy. Invisible and non-interactive, but a genuine editable
		element — the only thing a mobile browser will raise its keyboard for.
		16px font size is not cosmetic: iOS Safari auto-zooms the page whenever a
		focused field is smaller than that.
	-->
	<textarea
		bind:this={keyboardInput}
		oninput={handleKeyboardInput}
		onkeydown={handleKeyboardKeydown}
		onblur={() => (isKeyboardActive = false)}
		class="pointer-events-none absolute h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
		style="left: {keyboardAnchor.x}px; top: {keyboardAnchor.y}px; font-size: 16px;"
		aria-hidden="true"
		tabindex="-1"
		inputmode={keyboardInputMode}
		autocomplete="off"
		autocapitalize="sentences"
		spellcheck="false"
	></textarea>
{/if}
