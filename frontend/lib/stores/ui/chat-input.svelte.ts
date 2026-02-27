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

// Flag to skip next server restore (prevents stale input restoration
// when ChatInput is remounted during welcome→chat transition)
let _skipNextRestore = false;

export function setSkipNextRestore(skip: boolean) {
	_skipNextRestore = skip;
}

export function shouldSkipRestore(): boolean {
	if (_skipNextRestore) {
		_skipNextRestore = false;
		return true;
	}
	return false;
}

// Export reactive state
export const chatInputState = state;