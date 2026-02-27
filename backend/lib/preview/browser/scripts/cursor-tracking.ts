/**
 * Cursor Tracking Client Script
 *
 * This script runs in the headless browser to track cursor position
 * and user interactions for visual feedback in the preview.
 */

/**
 * Generate cursor tracking script that runs in the browser
 */
export function cursorTrackingScript() {
	let currentCursor = 'default';
	let mouseX = 0;
	let mouseY = 0;
	let lastInteractionTime = 0;

	// Simple cursor detection for UI feedback
	function updateCursorInfo() {
		const elementUnderMouse = document.elementFromPoint(mouseX, mouseY);
		if (elementUnderMouse) {
			const computedStyle = window.getComputedStyle(elementUnderMouse);
			const newCursor = computedStyle.cursor || 'default';

			if (newCursor !== currentCursor) {
				currentCursor = newCursor;
				// Update cursor info for UI feedback only
				(window as any).__cursorInfo = {
					cursor: currentCursor,
					x: mouseX,
					y: mouseY,
					timestamp: Date.now(),
					hasRecentInteraction: (Date.now() - lastInteractionTime) < 3000
				};
			}
		}
	}

	// Track interactions for user feedback only
	function markInteraction(type: string) {
		lastInteractionTime = Date.now();
		(window as any).__lastInteraction = {
			type: type,
			timestamp: lastInteractionTime,
			x: mouseX,
			y: mouseY
		};
	}

	// Track mouse position
	document.addEventListener('mousemove', (e) => {
		mouseX = e.clientX;
		mouseY = e.clientY;
		markInteraction('mousemove');
		updateCursorInfo();
	});

	// Track basic interactions
	document.addEventListener('click', (e) => {
		markInteraction('click');
		updateCursorInfo();
	});

	['mousedown', 'mouseup'].forEach(eventType => {
		document.addEventListener(eventType, (e) => {
			markInteraction(eventType);
			updateCursorInfo();
		});
	});

	// Initialize cursor info
	(window as any).__cursorInfo = {
		cursor: 'default',
		x: 0,
		y: 0,
		timestamp: Date.now(),
		hasRecentInteraction: false
	};

	(window as any).__lastInteraction = {
		type: 'init',
		timestamp: Date.now(),
		x: 0,
		y: 0
	};
}
