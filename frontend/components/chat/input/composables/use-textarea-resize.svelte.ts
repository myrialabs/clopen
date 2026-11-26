import { onDestroy } from 'svelte';

/** The box never grows past this... */
const MAX_HEIGHT_PX = 22.5 * 16; // 360px = 22.5rem
/** ...nor past this share of the chat panel, so the send button stays on screen in a short panel. */
const MAX_PANEL_SHARE = 0.35;
/** But it always fits a few lines. */
const MIN_CAP_PX = 6 * 16;

/** How tall the box may grow where it is now. */
function maxHeightFor(textarea: HTMLTextAreaElement): number {
	const panel = textarea.closest<HTMLElement>('[data-chat-panel]');
	const available = panel?.clientHeight || window.innerHeight;
	return Math.max(MIN_CAP_PX, Math.min(MAX_HEIGHT_PX, Math.floor(available * MAX_PANEL_SHARE)));
}

export function useTextareaResize() {
	let resizeObserver: ResizeObserver | null = null;
	let observedWidth = 0;
	let observedPanelHeight = 0;

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

		const maxHeight = maxHeightFor(textareaElement);

		// Hide overflow during measurement to prevent scrollbar from affecting width
		textareaElement.style.overflowY = 'hidden';

		// Empty: fit the placeholder
		if (!messageText || !messageText.trim()) {
			if (mirror) {
				mirror.value = placeholderForSizing;
				textareaElement.style.height = Math.min(mirror.scrollHeight, maxHeight) + 'px';
			} else {
				textareaElement.style.height = 'auto';
			}
			return;
		}

		// Reset height to auto to get accurate scrollHeight
		textareaElement.style.height = 'auto';

		// Measure content height and cap at max
		const scrollHeight = textareaElement.scrollHeight;
		const newHeight = Math.min(scrollHeight, maxHeight);
		textareaElement.style.height = newHeight + 'px';

		// Check actual overflow AFTER setting height to handle edge cases
		// where collapsed measurement differs from rendered content height
		textareaElement.style.overflowY =
			textareaElement.scrollHeight > textareaElement.clientHeight ? 'auto' : 'hidden';
	}

	/**
	 * Re-fit whenever the box's width or the panel's height changes (panel
	 * resize, layout settling after mount, rotating a phone, an on-screen
	 * keyboard opening) and once web fonts have loaded — a height
	 * measured against the old width or a fallback font wraps differently and
	 * clips the text.
	 */
	function observe(element: HTMLElement, refit: () => void) {
		resizeObserver?.disconnect();
		observedWidth = 0;
		observedPanelHeight = 0;
		const panel = element.closest<HTMLElement>('[data-chat-panel]');
		resizeObserver = new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				if (entry.target === element) {
					const width = entry.contentRect.width;
					if (width !== observedWidth) {
						observedWidth = width;
						changed = true;
					}
				} else {
					// A taller or shorter panel moves the height cap.
					const height = entry.contentRect.height;
					if (height !== observedPanelHeight) {
						observedPanelHeight = height;
						changed = true;
					}
				}
			}
			if (changed) refit();
		});
		resizeObserver.observe(element);
		if (panel) resizeObserver.observe(panel);
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
