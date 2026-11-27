/**
 * Chat Input State Store
 * Manages the chat input text and focus state
 */

/**
 * Text and attachments on their way into a session's message box: a message
 * that never reached the server, or something sent over from elsewhere in the
 * app, like a preview screenshot.
 */
export interface ComposerAddition {
	chatSessionId: string;
	text: string;
	attachments: { fileName: string; mediaType: string; data: string }[];
	/**
	 * Sent over as a mention (an editor selection, a page element): its `@N`
	 * is written into the text, the way picking it from `@` would.
	 */
	mention?: boolean;
}

interface ChatInputState {
	text: string;
	shouldFocus: boolean;
	/** Waiting for their session's composer; see addToComposer. */
	pending: ComposerAddition[];
}

// Create reactive state
const state = $state<ChatInputState>({
	text: '',
	shouldFocus: false,
	pending: []
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
 * Put text and attachments into a session's message box — a message that was
 * never sent, so nothing the user wrote is lost, or a screenshot to send.
 * Added to what is already there, never in place of it; picked up when that
 * session's composer is on screen.
 */
export function addToComposer(addition: ComposerAddition) {
	state.pending.push(addition);
}

/** Take the pending additions of a session out, oldest first. */
export function takeComposerAdditions(chatSessionId: string): ComposerAddition[] {
	const taken = state.pending.filter((m) => m.chatSessionId === chatSessionId);
	if (taken.length > 0) state.pending = state.pending.filter((m) => m.chatSessionId !== chatSessionId);
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