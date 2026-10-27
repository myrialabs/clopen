/**
 * "This user's paired chats changed": told when a chat pairs, unpairs, is
 * approved or rejected from the phone, so an open Settings panel
 * refreshes without a request from the tab.
 */

import { debug } from '$shared/utils/logger';

let listener: ((userId: string) => void) | null = null;

export function onLinksChanged(next: (userId: string) => void): void {
	listener = next;
}

export function notifyLinksChanged(userId: string): void {
	try {
		listener?.(userId);
	} catch (error) {
		debug.warn('chat-apps', 'Links-changed listener failed:', error);
	}
}
