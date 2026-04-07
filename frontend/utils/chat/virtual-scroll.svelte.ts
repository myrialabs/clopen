/**
 * Virtual Scroll for Chat Messages
 *
 * Manages a sliding window over the full message list,
 * only rendering a subset to the DOM for performance.
 * No placeholder divs — uses scroll position preservation instead.
 */

import { debug } from '$shared/utils/logger';

export const VS_CONFIG = {
	/** Max messages rendered at once */
	WINDOW_SIZE: 24,
	/** Messages to load when hitting a sentinel */
	BUFFER_SIZE: 8,
	/** Distance in px before sentinel to trigger load more */
	LOAD_MORE_MARGIN: 600,
} as const;

/**
 * Creates a virtual scroll state manager for chat messages.
 * Only manages window bounds — the component handles DOM/observers.
 *
 * Expand and trim are separate operations so the component can
 * restore scroll position between them (expand → restore → trim).
 */
export function createVirtualScroll() {
	const { WINDOW_SIZE, BUFFER_SIZE } = VS_CONFIG;

	let windowStart = $state(0);
	let windowEnd = $state(0);
	let totalCount = $state(0);
	let isActive = $state(false);

	/**
	 * Initialize/reset window for a given count, anchored to bottom.
	 */
	function reset(count: number) {
		totalCount = count;
		if (count <= WINDOW_SIZE) {
			windowStart = 0;
			windowEnd = count;
			isActive = false;
		} else {
			windowStart = count - WINDOW_SIZE;
			windowEnd = count;
			isActive = true;
		}
		debug.log('chat', `[VirtualScroll] Reset: ${windowStart}..${windowEnd} of ${count}, active=${isActive}`);
	}

	/**
	 * Sync with new total (messages added during streaming).
	 * Keeps window anchored to bottom when appropriate.
	 */
	function sync(newTotal: number, isAtBottom: boolean, isStreaming: boolean) {
		totalCount = newTotal;

		if (newTotal <= WINDOW_SIZE) {
			windowStart = 0;
			windowEnd = newTotal;
			isActive = false;
			return;
		}

		isActive = true;

		if (isAtBottom || isStreaming) {
			windowEnd = newTotal;
			if (windowEnd - windowStart > WINDOW_SIZE) {
				windowStart = windowEnd - WINDOW_SIZE;
			}
		}
	}

	/**
	 * Expand window upward (older messages). Does NOT trim.
	 * Call trimBottom() after scroll position is restored.
	 */
	function expandUp(): number {
		if (windowStart <= 0) return 0;
		const count = Math.min(BUFFER_SIZE, windowStart);
		windowStart -= count;
		debug.log('chat', `[VirtualScroll] Expand up +${count}: ${windowStart}..${windowEnd}`);
		return count;
	}

	/**
	 * Expand window downward (newer messages). Does NOT trim.
	 * Call trimTop() after if needed.
	 */
	function expandDown(): number {
		if (windowEnd >= totalCount) return 0;
		const count = Math.min(BUFFER_SIZE, totalCount - windowEnd);
		windowEnd += count;
		debug.log('chat', `[VirtualScroll] Expand down +${count}: ${windowStart}..${windowEnd}`);
		return count;
	}

	/** Trim bottom to keep window at WINDOW_SIZE. */
	function trimBottom() {
		if (windowEnd - windowStart <= WINDOW_SIZE) return;
		windowEnd = windowStart + WINDOW_SIZE;
	}

	/** Trim top to keep window at WINDOW_SIZE. */
	function trimTop() {
		if (windowEnd - windowStart <= WINDOW_SIZE) return;
		windowStart = windowEnd - WINDOW_SIZE;
	}

	/**
	 * Ensure a specific index is visible in the window.
	 * Used for edit mode / scroll-to-message.
	 */
	function ensureVisible(index: number) {
		if (index >= windowStart && index < windowEnd) return;

		if (index < windowStart) {
			windowStart = Math.max(0, index - 5);
			windowEnd = Math.min(totalCount, windowStart + WINDOW_SIZE);
		} else {
			windowEnd = Math.min(totalCount, index + 6);
			windowStart = Math.max(0, windowEnd - WINDOW_SIZE);
		}
		isActive = totalCount > WINDOW_SIZE;
		debug.log('chat', `[VirtualScroll] Ensure visible ${index}: ${windowStart}..${windowEnd}`);
	}

	return {
		get windowStart() { return windowStart; },
		get windowEnd() { return windowEnd; },
		get totalCount() { return totalCount; },
		get isActive() { return isActive; },
		get hasMoreAbove() { return windowStart > 0; },
		get hasMoreBelow() { return windowEnd < totalCount; },
		reset,
		sync,
		expandUp,
		expandDown,
		trimTop,
		trimBottom,
		ensureVisible,
	};
}
