export function useTextareaResize() {
	// Auto-resize textarea with proper single-line reset
	const MAX_HEIGHT_PX = 22.5 * 16; // 360px = 22.5rem

	function adjustTextareaHeight(
		textareaElement: HTMLTextAreaElement | undefined,
		messageText: string
	) {
		if (textareaElement) {
			// Hide overflow during measurement to prevent scrollbar from affecting width
			textareaElement.style.overflowY = 'hidden';
			// Reset height to auto to get accurate scrollHeight
			textareaElement.style.height = 'auto';

			// If content is empty, measure placeholder height instead
			if (!messageText || !messageText.trim()) {
				const placeholder = textareaElement.placeholder;
				if (placeholder) {
					// Temporarily set value to placeholder to measure wrapped height
					// (native placeholder doesn't affect scrollHeight)
					textareaElement.value = placeholder;
					const scrollHeight = textareaElement.scrollHeight;
					textareaElement.value = '';
					const newHeight = Math.min(scrollHeight, MAX_HEIGHT_PX);
					textareaElement.style.height = newHeight + 'px';
				}
				return;
			}

			// Measure content height and cap at max
			const scrollHeight = textareaElement.scrollHeight;
			const newHeight = Math.min(scrollHeight, MAX_HEIGHT_PX);
			textareaElement.style.height = newHeight + 'px';

			// Check actual overflow AFTER setting height to handle edge cases
			// where collapsed measurement differs from rendered content height
			textareaElement.style.overflowY =
				textareaElement.scrollHeight > textareaElement.clientHeight ? 'auto' : 'hidden';
		}
	}

	// Handle textarea input with debouncing for better performance
	function handleTextareaInput(
		textareaElement: HTMLTextAreaElement | undefined,
		messageText: string
	) {
		adjustTextareaHeight(textareaElement, messageText);
	}

	// Handle key events for better resize behavior
	function handleKeyDown(
		event: KeyboardEvent,
		textareaElement: HTMLTextAreaElement | undefined,
		messageText: string
	) {
		// Delay adjustment slightly for delete/backspace to ensure DOM is updated
		if (event.key === 'Backspace' || event.key === 'Delete') {
			setTimeout(() => {
				adjustTextareaHeight(textareaElement, messageText);
			}, 0);
		}
	}

	return {
		adjustTextareaHeight,
		handleTextareaInput,
		handleKeyDown
	};
}
