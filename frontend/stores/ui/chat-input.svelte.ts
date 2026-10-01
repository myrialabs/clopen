/**
 * Chat Input State Store
 * Manages the chat input text and focus state
 */

interface ChatInputState {
	text: string;
	shouldFocus: boolean;
}

// Create reactive state
const state = $state<ChatInputState>({
	text: '',
	shouldFocus: false
});

/**
 * Set input text and optionally focus
 */
export function setInputText(text: string, focus: boolean = true) {
	state.text = text;
	state.shouldFocus = focus;
}

/**
 * Clear input text
 */
export function clearInput() {
	state.text = '';
	state.shouldFocus = false;
}

/**
 * Reset focus flag after focusing
 */
export function resetFocus() {
	state.shouldFocus = false;
}

// Export reactive state
export const chatInputState = state;