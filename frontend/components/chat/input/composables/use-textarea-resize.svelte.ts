import { onDestroy } from 'svelte';

export function useTextareaResize() {
	// Auto-resize textarea with proper single-line reset
	const MAX_HEIGHT_PX = 22.5 * 16; // 360px = 22.5rem

	let resizeObserver: ResizeObserver | null = null;
	let observedWidth = 0;

	/**
	 * Fit the box to its content — or, when empty, to its placeholder, which a
	 * native textarea never measures.
	 *
	 * The placeholder is measured on `mirror`: a hidden twin rendered next to
	 * the textarea with the same classes, so it has the same width and the same
	 * wrapping by construction. Writing the placeholder into the real textarea
	 * instead (the old way) ran a layout pass on every animation frame and
	 * could clobber text an IME was still composing.
	 */
	function adjustTextareaHeight(
		textareaElement: HTMLTextAreaElement | undefined,
		mirror: HTMLTextAreaElement | undefined,
		messageText: string,
		placeholderForSizing: string
	) {
		if (!textareaElement) return;

		// Hide overflow during measurement to prevent scrollbar from affecting width
		textareaElement.style.overflowY = 'hidden';

		// Empty: fit the placeholder
		if (!messageText || !messageText.trim()) {
			if (mirror) {
				mirror.value = placeholderForSizing;
				textareaElement.style.height = Math.min(mirror.scrollHeight, MAX_HEIGHT_PX) + 'px';
			} else {
				textareaElement.style.height = 'auto';
			}
			return;
		}

		// Reset height to auto to get accurate scrollHeight
		textareaElement.style.height = 'auto';

		// Measure content height and cap at max
		const scrollHeight = textareaElement.scrollHeight;
		const newHeight = Math.min(scrollHeight, MAX_HEIGHT_PX);
		textareaElement.style.height = newHeight + 'px';

		// Check actual overflow AFTER setting height to handle edge cases
		// where collapsed measurement differs from rendered content height
		textareaElement.style.overflowY =
			textareaElement.scrollHeight > textareaElement.clientHeight ? 'auto' : 'hidden';
	}

	/**
	 * Re-fit whenever the box's width changes (panel resize, layout settling
	 * after mount, rotating a phone) and once web fonts have loaded — a height
	 * measured against the old width or a fallback font wraps differently and
	 * clips the text.
	 */
	function observe(element: HTMLElement, refit: () => void) {
		resizeObserver?.disconnect();
		observedWidth = 0;
		resizeObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			if (width === observedWidth) return;
			observedWidth = width;
			refit();
		});
		resizeObserver.observe(element);
		void document.fonts?.ready.then(refit);
	}

	onDestroy(() => {
		resizeObserver?.disconnect();
		resizeObserver = null;
	});

	return {
		adjustTextareaHeight,
		observe
	};
}
