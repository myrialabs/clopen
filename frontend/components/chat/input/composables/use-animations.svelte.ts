import { onDestroy } from 'svelte';

/**
 * Composable for managing placeholder and loading text animations
 * Combines placeholder typewriter effect and loading text rotation
 *
 * Both animations use a `destroyed` flag to prevent interval callbacks
 * from mutating state after the owning component is torn down (HMR / navigation).
 */

// ============================================================================
// PLACEHOLDER ANIMATION
// ============================================================================

export function usePlaceholderAnimation(placeholderTexts: string[]) {
	let currentPlaceholderIndex = $state(0);
	let placeholderText = $state('');
	let destroyed = false;

	// Track every active timer so stopPlaceholderAnimation can clear them all
	let typewriterInterval: number | null = null;
	let rotationInterval: number | null = null;
	let deleteTimeout: number | null = null;
	let deleteInterval: number | null = null;

	function typewritePlaceholder(text: string) {
		if (typewriterInterval) clearInterval(typewriterInterval);
		typewriterInterval = null;

		let idx = 0;
		placeholderText = '';

		typewriterInterval = window.setInterval(() => {
			if (destroyed) { clearInterval(typewriterInterval!); typewriterInterval = null; return; }
			if (idx < text.length) {
				placeholderText = text.substring(0, idx + 1);
				idx++;
			} else {
				clearInterval(typewriterInterval!);
				typewriterInterval = null;
			}
		}, 20);
	}

	function updatePlaceholder() {
		const fullText = placeholderTexts[currentPlaceholderIndex];

		if (deleteTimeout) clearTimeout(deleteTimeout);
		if (deleteInterval) clearInterval(deleteInterval);
		deleteTimeout = null;
		deleteInterval = null;

		deleteTimeout = window.setTimeout(() => {
			if (destroyed) return;
			deleteTimeout = null;

			deleteInterval = window.setInterval(() => {
				if (destroyed) { clearInterval(deleteInterval!); deleteInterval = null; return; }
				if (placeholderText.length > 0) {
					placeholderText = placeholderText.substring(0, placeholderText.length - 1);
				} else {
					clearInterval(deleteInterval!);
					deleteInterval = null;
					typewritePlaceholder(fullText);
				}
			}, 15);
		}, 2000);
	}

	function startPlaceholderAnimation() {
		stopPlaceholderAnimation();
		destroyed = false;

		currentPlaceholderIndex = Math.floor(Math.random() * placeholderTexts.length);
		typewritePlaceholder(placeholderTexts[currentPlaceholderIndex]);

		rotationInterval = window.setInterval(() => {
			if (destroyed) { clearInterval(rotationInterval!); rotationInterval = null; return; }
			currentPlaceholderIndex = (currentPlaceholderIndex + 1) % placeholderTexts.length;
			updatePlaceholder();
		}, 7000);
	}

	function stopPlaceholderAnimation() {
		if (typewriterInterval) { clearInterval(typewriterInterval); typewriterInterval = null; }
		if (rotationInterval) { clearInterval(rotationInterval); rotationInterval = null; }
		if (deleteTimeout) { clearTimeout(deleteTimeout); deleteTimeout = null; }
		if (deleteInterval) { clearInterval(deleteInterval); deleteInterval = null; }
	}

	function setStaticPlaceholder(text: string) {
		stopPlaceholderAnimation();
		placeholderText = text;
	}

	onDestroy(() => {
		destroyed = true;
		stopPlaceholderAnimation();
	});

	return {
		get placeholderText() { return placeholderText; },
		startAnimation: startPlaceholderAnimation,
		stopAnimation: stopPlaceholderAnimation,
		setStaticPlaceholder
	};
}

// ============================================================================
// LOADING TEXT ANIMATION
// ============================================================================

export function useLoadingTextAnimation(loadingTexts: string[]) {
	let visibleLoadingText = $state('');
	let currentFullText = '';
	let destroyed = false;

	let typewriterInterval: number | null = null;
	let rotationInterval: number | null = null;

	/**
	 * Typewriter: type characters one-by-one.
	 * Calls `onDone` when the full text has been typed.
	 */
	function typeText(text: string, onDone?: () => void) {
		if (typewriterInterval) clearInterval(typewriterInterval);
		typewriterInterval = null;

		let idx = 0;
		visibleLoadingText = '';

		typewriterInterval = window.setInterval(() => {
			if (destroyed) { clearInterval(typewriterInterval!); typewriterInterval = null; return; }
			if (idx < text.length) {
				visibleLoadingText = text.substring(0, idx + 1);
				idx++;
			} else {
				clearInterval(typewriterInterval!);
				typewriterInterval = null;
				onDone?.();
			}
		}, 40);
	}

	/**
	 * Backspace: delete characters one-by-one from the current visible text.
	 * Calls `onDone` when the text is fully erased.
	 */
	function deleteText(onDone?: () => void) {
		if (typewriterInterval) clearInterval(typewriterInterval);
		typewriterInterval = null;

		const snapshot = visibleLoadingText;
		let len = snapshot.length;

		typewriterInterval = window.setInterval(() => {
			if (destroyed) { clearInterval(typewriterInterval!); typewriterInterval = null; return; }
			if (len > 0) {
				len--;
				visibleLoadingText = snapshot.substring(0, len);
			} else {
				clearInterval(typewriterInterval!);
				typewriterInterval = null;
				onDone?.();
			}
		}, 40);
	}

	function pickNextText(): string {
		let next = currentFullText;
		while (next === currentFullText && loadingTexts.length > 1) {
			next = loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
		}
		return next;
	}

	/** Delete current text, then type new text */
	function transitionTo(newText: string) {
		currentFullText = newText;
		deleteText(() => {
			if (destroyed) return;
			typeText(newText);
		});
	}

	function startLoadingAnimation() {
		stopLoadingAnimation();
		destroyed = false;

		// Type the initial text character-by-character
		currentFullText = loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
		typeText(currentFullText);

		// Rotate to a new random text periodically
		rotationInterval = window.setInterval(() => {
			if (destroyed) { clearInterval(rotationInterval!); rotationInterval = null; return; }
			transitionTo(pickNextText());
		}, 15000);
	}

	function stopLoadingAnimation() {
		if (typewriterInterval) { clearInterval(typewriterInterval); typewriterInterval = null; }
		if (rotationInterval) { clearInterval(rotationInterval); rotationInterval = null; }
		visibleLoadingText = '';
	}

	onDestroy(() => {
		destroyed = true;
		stopLoadingAnimation();
	});

	return {
		get visibleLoadingText() { return visibleLoadingText; },
		startAnimation: startLoadingAnimation,
		stopAnimation: stopLoadingAnimation
	};
}
