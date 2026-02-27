<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getViewportDimensions, type DeviceSize, type Rotation } from '$frontend/lib/constants/preview';
	import { BrowserWebCodecsService, type BrowserWebCodecsStreamStats } from '$frontend/lib/services/preview/browser/browser-webcodecs.service';
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
		onRequestScreencastRefresh = $bindable<() => void>(() => {}) // Called when stream is stuck
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
	let navigationJustCompleted = false; // Track if navigation just completed (for fast refresh)

	// Recovery is only triggered by ACTUAL failures, not timeouts
	// - ICE connection failed
	// - WebCodecs connection closed unexpectedly
	// - Explicit errors
	const MAX_CONSECUTIVE_FAILURES = 2;
	const HEALTH_CHECK_INTERVAL = 2000; // Check every 2 seconds for connection health
	const FRAME_CHECK_INTERVAL = 500; // Check for first frame every 500ms (just for UI update, not recovery)
	const STUCK_STREAM_TIMEOUT = 5000; // Fallback: Request screencast refresh after 5 seconds of connected but no frame
	const NAVIGATION_FAST_REFRESH_DELAY = 500; // Fast refresh after navigation: 500ms

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
				ctx.imageSmoothingQuality = 'low'; // Faster rendering
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
		if (!sessionId || !canvasElement) return;

		// Prevent concurrent start attempts
		if (isStartingStream) {
			debug.log('webcodecs', 'Already starting stream, skipping duplicate call');
			return;
		}

		// If already streaming same session, skip
		if (isWebCodecsActive && activeStreamingSessionId === sessionId) {
			debug.log('webcodecs', 'Already streaming same session, skipping');
			return;
		}

		// Prevent duplicate requests for same session
		const requestId = `${sessionId}-${Date.now()}`;
		if (lastStartRequestId && lastStartRequestId.startsWith(sessionId)) {
			debug.log('webcodecs', `Duplicate start request for ${sessionId}, skipping`);
			return;
		}
		lastStartRequestId = requestId;

		isStartingStream = true;
		isStreamStarting = true; // Show loading overlay
		hasReceivedFirstFrame = false; // Reset first frame state

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

				// Setup cursor change handler
				webCodecsService.setOnCursorChange((cursor: string) => {
					updateCanvasCursor(cursor);
				});
			}

			// Start streaming with retry for session not ready cases
			debug.log('webcodecs', `Starting streaming for session: ${sessionId}`);

			let success = false;
			let retries = 0;
			const maxRetries = 5; // Increased for rapid tab switching
			const retryDelay = 500; // Increased delay for backend cleanup

			while (!success && retries < maxRetries) {
				try {
					success = await webCodecsService.startStreaming(sessionId, canvasElement);
					if (success) {
						isWebCodecsActive = true;
						isConnected = true;
						activeStreamingSessionId = sessionId;
						consecutiveFailures = 0; // Reset failure counter on success
						startHealthCheck(); // Start monitoring for stuck streams
						debug.log('webcodecs', 'Streaming started successfully');
						break;
					}
				} catch (error: any) {
					// Check if it's a retriable error - might just need more time
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
							// Don't throw - just fail silently and let user retry manually
							break;
						}
					} else {
						// Other errors - don't retry, just log
						debug.error('webcodecs', 'Streaming error:', error);
						break;
					}
				}
			}
		} finally {
			isStartingStream = false;
			isStreamStarting = false; // Hide "Launching browser..." (but may still show "Connecting..." until first frame)
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
			if (stats?.isConnected && !stats?.firstFrameRendered && elapsed >= STUCK_STREAM_TIMEOUT && !hasRequestedScreencastRefresh) {
				debug.warn('webcodecs', `Stream appears stuck (connected but no frame for ${elapsed}ms), requesting screencast refresh`);
				hasRequestedScreencastRefresh = true;
				onRequestScreencastRefresh();
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
			// Clear canvas to prevent stale frames, BUT keep last frame during navigation
			if (!isNavigating) {
				clearCanvas();
			} else {
				debug.log('webcodecs', 'Skipping canvas clear during navigation - keeping last frame');
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
		if (sessionId && canvasElement && sessionInfo) {
			// Skip during fast reconnect - fastReconnect() handles this case
			if (isReconnecting) {
				debug.log('webcodecs', 'Skipping streaming effect - fast reconnect in progress');
				return;
			}

			// Check if we need to start or restart streaming
			const needsStreaming = !isWebCodecsActive || activeStreamingSessionId !== sessionId;

			if (needsStreaming) {
				// Clear canvas immediately when session changes to prevent stale frames
				if (activeStreamingSessionId !== sessionId) {
					clearCanvas();
					hasReceivedFirstFrame = false; // Reset to show loading overlay
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

				// Longer delay to ensure backend session is fully ready
				// This is especially important during viewport/device change
				// when session is being recreated
				const timeout = setTimeout(() => {
					doStartStreaming();
				}, 200);

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

			canvas.addEventListener('touchstart', (e) => handleTouchStart(e, canvas), { passive: false });
			canvas.addEventListener('touchmove', (e) => handleTouchMove(e, canvas), { passive: false });
			canvas.addEventListener('touchend', (e) => handleTouchEnd(e, canvas), { passive: false });

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
				canvas.removeEventListener('touchstart', (e) => handleTouchStart(e, canvas));
				canvas.removeEventListener('touchmove', (e) => handleTouchMove(e, canvas));
				canvas.removeEventListener('touchend', (e) => handleTouchEnd(e, canvas));
			};
		}
	});

	// Touch event handlers
	function handleTouchStart(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0) return;
		event.preventDefault();

		const coords = getCanvasCoordinates(event, canvas);
		isMouseDown = true;
		mouseDownTime = Date.now();
		dragStartPos = { x: coords.x, y: coords.y };
		dragCurrentPos = { x: coords.x, y: coords.y };
		dragStarted = false; // Reset drag started flag
	}

	function handleTouchMove(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || event.touches.length === 0 || !isMouseDown || !dragStartPos) return;
		event.preventDefault();

		const coords = getCanvasCoordinates(event, canvas);
		dragCurrentPos = { x: coords.x, y: coords.y };

		const dragDistance = Math.sqrt(
			Math.pow(coords.x - dragStartPos.x, 2) + Math.pow(coords.y - dragStartPos.y, 2)
		);

		if (dragDistance > 15) {
			// Send mousedown on first drag detection
			if (!dragStarted) {
				sendInteraction({
					type: 'mousedown',
					x: dragStartPos.x,
					y: dragStartPos.y,
					button: 'left'
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
	}

	function handleTouchEnd(event: TouchEvent, canvas: HTMLCanvasElement) {
		if (!sessionId || !isMouseDown) return;
		event.preventDefault();

		if (dragStartPos) {
			const endPos = dragCurrentPos || dragStartPos;

			// If drag was started (mousedown was sent), send mouseup
			if (dragStarted) {
				sendInteraction({
					type: 'mouseup',
					x: endPos.x,
					y: endPos.y,
					button: 'left'
				});
			} else {
				// No drag occurred, this is a tap/click
				sendInteraction({ type: 'click', x: dragStartPos.x, y: dragStartPos.y });
			}
		}

		isMouseDown = false;
		isDragging = false;
		dragStartPos = null;
		dragCurrentPos = null;
		dragStarted = false;
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
			notifyNavigationComplete
		};
	});

	onDestroy(() => {
		stopHealthCheck(); // Stop health monitoring
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
