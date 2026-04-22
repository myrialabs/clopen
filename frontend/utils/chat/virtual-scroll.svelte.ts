/**
 * Virtual Scroll for Chat Messages
 *
 * Manages a sliding window over the full message list,
 * only rendering a subset to the DOM for performance.
 * No placeholder divs — uses scroll position preservation instead.
 */

import { debug } from '$shared/utils/logger';

export const VS_CONFIG_CLASSIC = {
	/** Max messages rendered at once */
	WINDOW_SIZE: 20,
	/** Messages to load when hitting a sentinel */
	BUFFER_SIZE: 5,
	/** Distance in px before sentinel to trigger load more */
	LOAD_MORE_MARGIN: 600,
} as const;

export const VS_CONFIG_COMPACT = {
	/** Max messages rendered at once */
	WINDOW_SIZE: 60,
	/** Messages to load when hitting a sentinel */
	BUFFER_SIZE: 10,
	/** Distance in px before sentinel to trigger load more */
	LOAD_MORE_MARGIN: 400,
} as const;

type VSConfig = { WINDOW_SIZE: number; BUFFER_SIZE: number; LOAD_MORE_MARGIN: number };

/**
 * Creates a virtual scroll state manager for chat messages.
 * Only manages window bounds — the component handles DOM/observers.
 *
 * Expand and trim are separate operations so the component can
 * restore scroll position between them (expand → restore → trim).
 */
export function createVirtualScroll(getConfig: () => VSConfig = () => VS_CONFIG_CLASSIC) {
	let windowStart = $state(0);
	let windowEnd = $state(0);
	let totalCount = $state(0);
	let isActive = $state(false);

	/**
	 * Initialize/reset window for a given count, anchored to bottom.
	 */
	function reset(count: number) {
		const { WINDOW_SIZE } = getConfig();
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
		const { WINDOW_SIZE } = getConfig();
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
		const count = Math.min(getConfig().BUFFER_SIZE, windowStart);
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
		const count = Math.min(getConfig().BUFFER_SIZE, totalCount - windowEnd);
		windowEnd += count;
		debug.log('chat', `[VirtualScroll] Expand down +${count}: ${windowStart}..${windowEnd}`);
		return count;
	}

	/** Trim bottom to keep window at WINDOW_SIZE. */
	function trimBottom() {
		const { WINDOW_SIZE } = getConfig();
		if (windowEnd - windowStart <= WINDOW_SIZE) return;
		windowEnd = windowStart + WINDOW_SIZE;
	}

	/** Trim top to keep window at WINDOW_SIZE. */
	function trimTop() {
		const { WINDOW_SIZE } = getConfig();
		if (windowEnd - windowStart <= WINDOW_SIZE) return;
		windowStart = windowEnd - WINDOW_SIZE;
	}

	/**
	 * Ensure a specific index is visible in the window.
	 * Used for edit mode / scroll-to-message.
	 */
	function ensureVisible(index: number) {
		const { WINDOW_SIZE } = getConfig();
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
		get loadMoreMargin() { return getConfig().LOAD_MORE_MARGIN; },
		reset,
		sync,
		expandUp,
		expandDown,
		trimTop,
		trimBottom,
		ensureVisible,
	};
}
