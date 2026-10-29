/**
 * "The paired chats changed": told when a chat pairs or unpairs from the
 * phone, so an open Settings panel refreshes without a request from the tab.
 */

import { debug } from '$shared/utils/logger';

let listener: (() => void) | null = null;

export function onLinksChanged(next: () => void): void {
	listener = next;
}

export function notifyLinksChanged(): void {
	try {
		listener?.();
	} catch (error) {
		debug.warn('chat-apps', 'Links-changed listener failed:', error);
	}
}
