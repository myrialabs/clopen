/**
 * Chat Input State Store
 * Manages the chat input text and focus state
 */

/** A message that never reached the server, on its way back into the box. */
export interface ReturnedMessage {
	chatSessionId: string;
	text: string;
	attachments: { fileName: string; mediaType: string; data: string }[];
}

interface ChatInputState {
	text: string;
	shouldFocus: boolean;
	/** Waiting for their session's composer; see returnToComposer. */
	returned: ReturnedMessage[];
}

// Create reactive state
const state = $state<ChatInputState>({
	text: '',
	shouldFocus: false,
	returned: []
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
 * Put a message that was never sent back into its session's message box, so
 * nothing the user wrote is lost. Added to what is already there, never in
 * place of it; picked up when that session's composer is on screen.
 */
export function returnToComposer(message: ReturnedMessage) {
	state.returned.push(message);
}

/** Take the returned messages of a session out, oldest first. */
export function takeReturned(chatSessionId: string): ReturnedMessage[] {
	const taken = state.returned.filter((m) => m.chatSessionId === chatSessionId);
	if (taken.length > 0) state.returned = state.returned.filter((m) => m.chatSessionId !== chatSessionId);
	return taken;
}

/**
 * Reset focus flag after focusing
 */
export function resetFocus() {
	state.shouldFocus = false;
}

// Export reactive state
export const chatInputState = state;