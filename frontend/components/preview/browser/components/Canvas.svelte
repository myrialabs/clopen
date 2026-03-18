<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getViewportDimensions, type DeviceSize, type Rotation } from '$frontend/utils/preview-constants';
	import { BrowserWebCodecsService, type BrowserWebCodecsStreamStats } from '$frontend/services/preview/browser/browser-webcodecs.service';
	import { debug } from '$shared/utils/logger';

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
		onTouchCursorUpdate = $bindable<(pos: { x: number; y: number; visible: boolean; clicking?: boolean }) => void>(() => {})
	} = $props();

	// WebCodecs service instance
	let webCodecsService: BrowserWebCodecsService | null = null;
	let isWebCodecsActive = $state(false);
	let activeStreamingSessionId: string | null = null; // Track which session is currently streaming
	let isStartingStream = false; // Prevent concurrent start attempts
	let lastStartRequestId: string | null = null; // Track the last start request to prevent duplicates

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

	// Canvas snapshot storage for instant tab switching
	// Stores a clone of the canvas per sessionId so switching back shows content immediately
	const canvasSnapshots = new Map<string, HTMLCanvasElement>();
	const MAX_SNAPSHOTS = 10;
	let hasRestoredSnapshot = false; // Prevents canvas clear/reset during streaming start

	// Recovery is only triggered by ACTUAL failures, not timeouts
	// - ICE connection failed
	// - WebCodecs connection closed unexpectedly
	// - Explicit errors
	const MAX_CONSECUTIVE_FAILURES = 2;
	const HEALTH_CHECK_INTERVAL = 2000; // Check every 2 seconds for connection health
	const FRAME_CHECK_INTERVAL = 100; // Fallback poll for first frame (primary path is onFirstFrame callback)
	const STUCK_STREAM_TIMEOUT = 3000; // Fallback: Request screencast refresh after 3 seconds of connected but no frame
	const NAVIGATION_FAST_REFRESH_DELAY = 300; // Fast refresh after navigation: 300ms

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

	// Utility function to convert canvas display coordinates to browser coordinates
	function getCanvasCoordinates(event: MouseEvent | TouchEvent, canvas: HTMLCanvasElement): { x: number, y: number } {
		const rect = canvas.getBoundingClientRect();
		const scaleX = canvas.width / rect.width;
		const scaleY = canvas.height / rect.height;

		let clientX: number, clientY: number;

		if (event instanceof MouseEvent) {
			clientX = event.clientX;
			clientY = event.clientY;
		} else {
			// Touch event - use first touch
			const touch = event.touches[0] || event.changedTouches[0];
			clientX = touch.clientX;
			clientY = touch.clientY;
		}

		const x = (clientX - rect.left) * scaleX;
		const y = (clientY - rect.top) * scaleY;

		return {
			x: Math.round(x),
			y: Math.round(y)
		};
	}


	function handleCanvasMouseMove(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;

		const coords = getCanvasCoordinates(event, canvas);

		if (isMouseDown && dragStartPos) {
			dragCurrentPos = { x: coords.x, y: coords.y };

			const dragDistance = Math.sqrt(
				Math.pow(coords.x - dragStartPos.x, 2) + Math.pow(coords.y - dragStartPos.y, 2)
			);

			// Start drag when distance exceeds threshold
			if (dragDistance > 10) {
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

	function handleCanvasKeydown(event: KeyboardEvent) {
		if (!sessionId) return;

		// Prevent default for all keyboard events to avoid affecting parent page
		// This prevents Ctrl+A, Ctrl+C, arrow keys, etc. from affecting the parent
		event.preventDefault();
		event.stopPropagation();

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
		debug.log('webcodecs', `[DIAG] startStreaming() called: sessionId=${sessionId}, canvasElement=${!!canvasElement}, isStartingStream=${isStartingStream}, isWebCodecsActive=${isWebCodecsActive}, activeStreamingSessionId=${activeStreamingSessionId}, lastStartRequestId=${lastStartRequestId}`);

		if (!sessionId || !canvasElement) {
			debug.log('webcodecs', `[DIAG] startStreaming() early exit: missing sessionId=${!sessionId} or canvasElement=${!canvasElement}`);
			return;
		}

		// Prevent concurrent start attempts
		if (isStartingStream) {
			debug.log('webcodecs', '[DIAG] startStreaming() skipped: already starting stream');
			return;
		}

		// If already streaming same session, skip
		if (isWebCodecsActive && activeStreamingSessionId === sessionId) {
			debug.log('webcodecs', '[DIAG] startStreaming() skipped: already streaming same session');
			return;
		}

		// Prevent duplicate requests for same session
		const requestId = `${sessionId}-${Date.now()}`;
		if (lastStartRequestId && lastStartRequestId.startsWith(sessionId)) {
			debug.log('webcodecs', `[DIAG] startStreaming() skipped: duplicate request for ${sessionId}, lastStartRequestId=${lastStartRequestId}`);
			return;
		}
		lastStartRequestId = requestId;

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
				// Small delay to ensure cleanup is complete
				await new Promise(resolve => setTimeout(resolve, 100));
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
					isStartingStream = false;
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
				try {
					success = await webCodecsService.startStreaming(sessionId, canvasElement);
					if (success) {
						isWebCodecsActive = true;
						isConnected = true;
						activeStreamingSessionId = sessionId;
						consecutiveFailures = 0; // Reset failure counter on success
						startHealthCheck(hasRestoredSnapshot); // Skip first frame reset if snapshot
						hasRestoredSnapshot = false; // Reset after using
						debug.log('webcodecs', 'Streaming started successfully');
					} else {
						// Service handles errors internally and returns false.
						// Retry after a delay — the peer/offer may need more time to initialize.
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
					// This block only runs if the service unexpectedly throws.
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

		consecutiveFailures++;
		debug.log('webcodecs', `Recovery attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} for session ${sessionId}`);

		if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
			debug.error('webcodecs', 'Max recovery attempts reached, giving up');
			isRecovering = false;
			await stopStreaming();
			return;
		}

		// Stop and restart streaming
		try {
			isRecovering = true; // Show "Reconnecting..." overlay
			hasReceivedFirstFrame = false; // Reset for recovery
			await stopStreaming();
			lastStartRequestId = null; // Clear to allow new start request
			await new Promise(resolve => setTimeout(resolve, 500)); // Wait for cleanup
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

		debug.log('webcodecs', `🚀 Fast reconnect for session ${sessionId} (reconnect only, no backend stop)`);

		try {
			isRecovering = true;
			isStartingStream = true;

			// Set isReconnecting to prevent loading overlay during reconnect
			// This ensures the last frame stays visible instead of "Loading preview..."
			isReconnecting = true;

			// Don't reset hasReceivedFirstFrame - keep showing last frame during reconnect

			// Use reconnectToExistingStream which does NOT stop backend streaming
			const success = await webCodecsService.reconnectToExistingStream(sessionId, canvasElement);

			if (success) {
				isWebCodecsActive = true;
				isConnected = true;
				activeStreamingSessionId = sessionId;
				consecutiveFailures = 0;
				startHealthCheck(true); // Skip resetting hasReceivedFirstFrame to keep overlay stable
				debug.log('webcodecs', '✅ Fast reconnect successful');
			} else {
				throw new Error('Reconnect returned false');
			}
		} catch (error) {
			debug.error('webcodecs', 'Fast reconnect failed:', error);
			// Fall back to regular recovery on failure
			consecutiveFailures++;
			isStartingStream = false;
			isReconnecting = false; // Reset on failure
			attemptRecovery();
		} finally {
			isRecovering = false;
			isStartingStream = false;
			// Note: isReconnecting will be reset when first frame is received
		}
	}

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
				const doStartStreaming = async () => {
					if (activeStreamingSessionId && activeStreamingSessionId !== sessionId) {
						debug.log('webcodecs', `Session changed from ${activeStreamingSessionId} to ${sessionId}, stopping old stream first`);
						await stopStreaming();
						// Wait a bit for cleanup
						await new Promise(resolve => setTimeout(resolve, 100));
					}
					await startStreaming();
				};

				// Small delay to ensure backend session is ready
				const timeout = setTimeout(() => {
					doStartStreaming();
				}, 50);

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
				// Low-end optimized throttle: reduced CPU usage
				// 32ms hover = ~30fps, 16ms drag = ~60fps
				const throttleMs = isDragging ? 16 : 32;
				if (now - lastMoveTime >= throttleMs) {
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

		return () => {
			touchTarget.removeEventListener('touchstart', touchStartHandler);
			touchTarget.removeEventListener('touchmove', touchMoveHandler);
			touchTarget.removeEventListener('touchend', touchEndHandler);
		};
	});

	// Convert canvas coordinates to viewport (screen) coordinates for VirtualCursor display
	function canvasToScreen(cx: number, cy: number): { x: number; y: number } {
		if (!canvasElement) return { x: 0, y: 0 };
		const rect = canvasElement.getBoundingClientRect();
		return {
			x: rect.left + cx * (rect.width / canvasElement.width),
			y: rect.top + cy * (rect.height / canvasElement.height)
		};
	}

	// Show / hide cursor when touchMode changes
	$effect(() => {
		if (touchMode === 'cursor') {
			// Init cursor at canvas center on first activation
			if (canvasElement && trackpadCursorX === 0 && trackpadCursorY === 0) {
				trackpadCursorX = canvasElement.width / 2;
				trackpadCursorY = canvasElement.height / 2;
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
			}
			trackpadTwoFingerActive = true;
			trackpadTwoFingerStartTime = Date.now();
			trackpadTwoFingerTotalDist = 0;
			const t1 = event.touches[0];
			const t2 = event.touches[1];
			trackpadTwoFingerLastCenterX = (t1.clientX + t2.clientX) / 2;
			trackpadTwoFingerLastCenterY = (t1.clientY + t2.clientY) / 2;
			return;
		}

		if (trackpadTwoFingerActive) return; // Ignore until two-finger gesture fully ends

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
				sendInteraction({ type: 'mousedown', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
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
				const rect = canvasElement.getBoundingClientRect();
				const scale = canvasElement.width / rect.width;
				sendInteraction({ type: 'scroll', deltaX: deltaX * scale * 2, deltaY: deltaY * scale * 2 });
			}
			return;
		}

		if (event.touches.length !== 1 || !isMouseDown || trackpadTwoFingerActive) return;

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
		if (totalDist > 8 && longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}

		// Convert screen delta → canvas delta and move cursor
		const rect = canvasElement.getBoundingClientRect();
		const scale = canvasElement.width / rect.width;
		trackpadCursorX = Math.max(0, Math.min(canvasElement.width, trackpadCursorX + deltaClientX * scale));
		trackpadCursorY = Math.max(0, Math.min(canvasElement.height, trackpadCursorY + deltaClientY * scale));

		// Send mousemove so the browser sees hover state changes
		sendInteraction({ type: 'mousemove', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });

		// Update virtual cursor display
		const pos = canvasToScreen(trackpadCursorX, trackpadCursorY);
		onTouchCursorUpdate({ x: pos.x, y: pos.y, visible: true });
	}

	function handleTrackpadTouchEnd(event: TouchEvent) {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

		const remainingTouches = event.touches.length;

		if (trackpadTwoFingerActive) {
			if (remainingTouches === 0) {
				// All fingers lifted: check for two-finger tap → right click
				const duration = Date.now() - trackpadTwoFingerStartTime;
				if (duration < 300 && trackpadTwoFingerTotalDist < 20) {
					sendInteraction({ type: 'rightclick', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });
				}
				trackpadTwoFingerActive = false;
			} else if (remainingTouches === 1) {
				// One finger remains: transition back to single-finger tracking
				const touch = event.touches[0];
				trackpadLastClientX = touch.clientX;
				trackpadLastClientY = touch.clientY;
				trackpadTouchStartClientX = touch.clientX;
				trackpadTouchStartClientY = touch.clientY;
				isMouseDown = true;
				mouseDownTime = Date.now();
				trackpadTwoFingerActive = false;
			}
			return;
		}

		if (!isMouseDown) return;

		if (touchLongPressed && dragStarted) {
			sendInteraction({ type: 'mouseup', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY), button: 'left' });
		} else {
			// Tap: short + minimal movement → left click at cursor position
			const duration = Date.now() - mouseDownTime;
			const moveDist = Math.sqrt(
				Math.pow(trackpadLastClientX - trackpadTouchStartClientX, 2) +
				Math.pow(trackpadLastClientY - trackpadTouchStartClientY, 2)
			);
			if (duration < 250 && moveDist < 10) {
				sendInteraction({ type: 'click', x: Math.round(trackpadCursorX), y: Math.round(trackpadCursorY) });
			}
		}

		isMouseDown = false;
		dragStarted = false;
		touchLongPressed = false;
	}

	// ── Touch event handlers (dispatch to scroll or trackpad mode) ────────────

	// Touch event handlers
	function handleTouchStart(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0) return;
		event.preventDefault();

		if (touchMode === 'cursor') {
			handleTrackpadTouchStart(event);
			return;
		}

		// ── Scroll mode ──────────────────────────────────────────────────────────
		if (event.touches.length > 1) return;

		const coords = getCanvasCoordinates(event, canvas);
		isMouseDown = true;
		mouseDownTime = Date.now();
		dragStartPos = { x: coords.x, y: coords.y };
		dragCurrentPos = { x: coords.x, y: coords.y };
		dragStarted = false;
		touchLongPressed = false;
		lastTouchCoords = { x: coords.x, y: coords.y };

		// Long-press detection: after 500ms without significant movement → drag mode
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
				dragStarted = true;
				sendInteraction({ type: 'mousedown', x: dragStartPos.x, y: dragStartPos.y, button: 'left' });
			}
		}, 500);
	}

	function handleTouchMove(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0) return;
		event.preventDefault();

		if (touchMode === 'cursor') {
			handleTrackpadTouchMove(event);
			return;
		}

		// ── Scroll mode ──────────────────────────────────────────────────────────
		if (!isMouseDown || !dragStartPos) return;

		const coords = getCanvasCoordinates(event, canvas);
		dragCurrentPos = { x: coords.x, y: coords.y };

		const dist = Math.sqrt(
			Math.pow(coords.x - dragStartPos.x, 2) + Math.pow(coords.y - dragStartPos.y, 2)
		);

		if (dist > 10 && longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}

		if (touchLongPressed) {
			isDragging = true;
			sendInteraction({ type: 'mousemove', x: coords.x, y: coords.y });
		} else {
			if (lastTouchCoords) {
				const deltaX = lastTouchCoords.x - coords.x;
				const deltaY = lastTouchCoords.y - coords.y;
				sendInteraction({ type: 'scroll', deltaX, deltaY });
			}
			lastTouchCoords = { x: coords.x, y: coords.y };
		}
	}

	function handleTouchEnd(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId) return;
		event.preventDefault();

		if (touchMode === 'cursor') {
			handleTrackpadTouchEnd(event);
			return;
		}

		// ── Scroll mode ──────────────────────────────────────────────────────────
		if (!isMouseDown) return;

		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

		if (touchLongPressed && dragStarted) {
			const endPos = dragCurrentPos || dragStartPos;
			if (endPos) sendInteraction({ type: 'mouseup', x: endPos.x, y: endPos.y, button: 'left' });
		} else if (!isDragging && dragStartPos) {
			const touchDuration = Date.now() - mouseDownTime;
			const dist = dragCurrentPos
				? Math.sqrt(
						Math.pow(dragCurrentPos.x - dragStartPos.x, 2) +
						Math.pow(dragCurrentPos.y - dragStartPos.y, 2)
					)
				: 0;
			if (touchDuration < 300 && dist < 15) {
				sendInteraction({ type: 'click', x: dragStartPos.x, y: dragStartPos.y });
			}
		}

		isMouseDown = false;
		isDragging = false;
		dragStartPos = null;
		dragCurrentPos = null;
		dragStarted = false;
		touchLongPressed = false;
		lastTouchCoords = null;
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
			// Streaming control
			startStreaming,
			stopStreaming,
			isActive: () => isWebCodecsActive,
			getStats: () => webCodecsService?.getStats() ?? null,
			getLatency: () => latencyMs,
			// Navigation handling
			notifyNavigationComplete,
			freezeForSpaNavigation: () => webCodecsService?.freezeForSpaNavigation()
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
