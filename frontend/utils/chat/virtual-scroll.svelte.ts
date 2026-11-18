/**
 * Virtual Scroll for Chat Messages
 *
 * Manages a sliding window over the full message list,
 * only rendering a subset to the DOM for performance.
 * No placeholder divs — the component keeps the reading position in place
 * across every expand/trim (see the anchor keeper in ChatMessages).
 */

import { debug } from '$shared/utils/logger';

export const VS_CONFIG_CLASSIC = {
	/** Max messages rendered at once */
	WINDOW_SIZE: 30,
	/** Messages to load when hitting a sentinel */
	BUFFER_SIZE: 10,
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
	 *
	 * A window that reached the end grows to include the new messages; it is
	 * trimmed back to WINDOW_SIZE only for a reader at the bottom (the rest is
	 * trimmed by the edges as they scroll). A window over older messages stays
	 * exactly where it is — moving it to the end because a turn is streaming
	 * replaced everything the reader was looking at.
	 */
	function sync(newTotal: number, isAtBottom: boolean) {
		const { WINDOW_SIZE } = getConfig();
		const wasAtEnd = windowEnd >= totalCount;
		totalCount = newTotal;

		if (newTotal <= WINDOW_SIZE) {
			windowStart = 0;
			windowEnd = newTotal;
			isActive = false;
			return;
		}

		isActive = true;

		if (wasAtEnd) {
			windowEnd = newTotal;
			if (isAtBottom && windowEnd - windowStart > WINDOW_SIZE) {
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

	/**
	 * Trim bottom toward WINDOW_SIZE, dropping at most `max` items — the caller
	 * passes how many are safely off screen so nothing visible disappears.
	 */
	function trimBottom(max = Infinity) {
		const { WINDOW_SIZE } = getConfig();
		const excess = Math.min(windowEnd - windowStart - WINDOW_SIZE, max);
		if (excess <= 0) return;
		windowEnd -= excess;
	}

	/** Trim top toward WINDOW_SIZE, dropping at most `max` items (see trimBottom). */
	function trimTop(max = Infinity) {
		const { WINDOW_SIZE } = getConfig();
		const excess = Math.min(windowEnd - windowStart - WINDOW_SIZE, max);
		if (excess <= 0) return;
		windowStart += excess;
	}

	/**
	 * Older items were inserted at the front of the list. Shift the window by the
	 * same amount so it keeps covering exactly the items it covered before — the
	 * DOM does not change; `expandUp` then reveals the new ones.
	 */
	function prepend(added: number) {
		if (added <= 0) return;
		const wasActive = isActive;
		totalCount += added;
		if (wasActive) {
			windowStart += added;
			windowEnd += added;
		} else {
			// Everything was rendered; now the new items sit above the window.
			windowStart = added;
			windowEnd = totalCount;
			isActive = true;
		}
		debug.log('chat', `[VirtualScroll] Prepend +${added}: ${windowStart}..${windowEnd} of ${totalCount}`);
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
		get bufferSize() { return getConfig().BUFFER_SIZE; },
		reset,
		sync,
		expandUp,
		expandDown,
		trimTop,
		trimBottom,
		prepend,
		ensureVisible,
	};
}
