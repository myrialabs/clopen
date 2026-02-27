import { onDestroy } from 'svelte';

/**
 * Composable for managing placeholder and loading text animations
 * Combines placeholder typewriter effect and loading text rotation
 */

// ============================================================================
// PLACEHOLDER ANIMATION
// ============================================================================

export function usePlaceholderAnimation(placeholderTexts: string[]) {
	let currentPlaceholderIndex = $state(0);
	let placeholderText = $state('');
	let placeholderTypewriterInterval: number | null = null;
	let placeholderRotationInterval: number | null = null;
	let placeholderDeleteTimeout: number | null = null;

	// Typewriter effect for placeholder
	function typewritePlaceholder(text: string) {
		if (placeholderTypewriterInterval) {
			clearInterval(placeholderTypewriterInterval);
		}

		let currentIndex = 0;
		placeholderText = '';

		placeholderTypewriterInterval = window.setInterval(() => {
			if (currentIndex < text.length) {
				placeholderText = text.substring(0, currentIndex + 1);
				currentIndex++;
			} else {
				clearInterval(placeholderTypewriterInterval!);
				placeholderTypewriterInterval = null;
			}
		}, 20); // Typing speed
	}

	// Update placeholder with typewriter effect
	function updatePlaceholder() {
		const fullText = placeholderTexts[currentPlaceholderIndex];

		// Clear any existing delete timeout
		if (placeholderDeleteTimeout) {
			clearTimeout(placeholderDeleteTimeout);
		}

		// Use a tracked timeout that can be cleared properly
		placeholderDeleteTimeout = window.setTimeout(() => {
			// Clear current text with backspace effect
			let deleteInterval = window.setInterval(() => {
				if (placeholderText.length > 0) {
					placeholderText = placeholderText.substring(0, placeholderText.length - 1);
				} else {
					clearInterval(deleteInterval);
					// Start typing new text
					typewritePlaceholder(fullText);
				}
			}, 15); // Delete speed
		}, 2000); // Wait 2 seconds before deleting
	}

	function startPlaceholderAnimation() {
		// Clear any existing intervals first
		stopPlaceholderAnimation();

		currentPlaceholderIndex = Math.floor(Math.random() * placeholderTexts.length);
		// Initial placeholder
		const initialText = placeholderTexts[currentPlaceholderIndex];
		typewritePlaceholder(initialText);

		// Rotate placeholders
		placeholderRotationInterval = window.setInterval(() => {
			currentPlaceholderIndex = (currentPlaceholderIndex + 1) % placeholderTexts.length;
			updatePlaceholder();
		}, 7000); // Change every 7 seconds
	}

	function stopPlaceholderAnimation() {
		if (placeholderTypewriterInterval) {
			clearInterval(placeholderTypewriterInterval);
			placeholderTypewriterInterval = null;
		}
		if (placeholderRotationInterval) {
			clearInterval(placeholderRotationInterval);
			placeholderRotationInterval = null;
		}
		if (placeholderDeleteTimeout) {
			clearTimeout(placeholderDeleteTimeout);
			placeholderDeleteTimeout = null;
		}
	}

	function setStaticPlaceholder(text: string) {
		stopPlaceholderAnimation();
		placeholderText = text;
	}

	// Cleanup on destroy
	onDestroy(() => {
		stopPlaceholderAnimation();
	});

	return {
		get placeholderText() {
			return placeholderText;
		},
		startAnimation: startPlaceholderAnimation,
		stopAnimation: stopPlaceholderAnimation,
		setStaticPlaceholder
	};
}

// ============================================================================
// LOADING TEXT ANIMATION
// ============================================================================

export function useLoadingTextAnimation(loadingTexts: string[]) {
	let currentLoadingText = $state('thinking');
	let visibleLoadingText = $state('thinking');
	let loadingTextIntervalId: number | null = null;
	let typewriterIntervalId: number | null = null;

	// Typewriter effect for smooth text transition
	function animateTextTransition(newText: string) {
		if (typewriterIntervalId) {
			clearInterval(typewriterIntervalId);
		}

		const oldText = visibleLoadingText;
		let deleteIndex = oldText.length;
		let typeIndex = 0;
		let isDeleting = true;

		typewriterIntervalId = window.setInterval(() => {
			if (isDeleting) {
				// Delete characters
				if (deleteIndex > 0) {
					visibleLoadingText = oldText.substring(0, deleteIndex - 1);
					deleteIndex--;
				} else {
					// Finished deleting, start typing
					isDeleting = false;
				}
			} else {
				// Type new characters
				if (typeIndex < newText.length) {
					visibleLoadingText = newText.substring(0, typeIndex + 1);
					typeIndex++;
				} else {
					// Finished typing
					clearInterval(typewriterIntervalId!);
					typewriterIntervalId = null;
				}
			}
		}, 50); // Adjust speed here (lower = faster)
	}

	function startLoadingAnimation() {
		// Clear any existing intervals first to prevent duplication
		stopLoadingAnimation();

		// Start loading text rotation with typewriter effect
		currentLoadingText = loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
		visibleLoadingText = currentLoadingText;
		loadingTextIntervalId = window.setInterval(() => {
			// Get a different text than the current one
			let newText = currentLoadingText;
			while (newText === currentLoadingText && loadingTexts.length > 1) {
				newText = loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
			}
			currentLoadingText = newText;
			animateTextTransition(newText);
		}, 15000);
	}

	function stopLoadingAnimation() {
		// Clear loading text interval
		if (loadingTextIntervalId) {
			window.clearInterval(loadingTextIntervalId);
			loadingTextIntervalId = null;
		}
		if (typewriterIntervalId) {
			window.clearInterval(typewriterIntervalId);
			typewriterIntervalId = null;
		}
	}

	// Cleanup on destroy
	onDestroy(() => {
		stopLoadingAnimation();
	});

	return {
		get visibleLoadingText() {
			return visibleLoadingText;
		},
		startAnimation: startLoadingAnimation,
		stopAnimation: stopLoadingAnimation
	};
}
