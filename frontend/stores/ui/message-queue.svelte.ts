/**
 * Message Queue Store
 *
 * Messages sent while the AI is still working wait in a queue on the server,
 * which starts the next one each time a turn completes (see
 * backend/ws/chat/composer.ts). This mirrors that queue for the session on
 * screen; the server is the source of truth.
 */

import ws from '$frontend/utils/ws';
import { sessionState } from '$frontend/stores/core/sessions.svelte';

export interface QueuedMessage {
	id: string;
	userId: string;
	userName: string;
	createdAt: string;
	text: string;
	attachmentCount: number;
}

const state = $state<{ chatSessionId: string | null; items: QueuedMessage[] }>({
	chatSessionId: null,
	items: []
});

/** Replace the mirror with the server's queue for a session. */
export function setQueue(chatSessionId: string, items: QueuedMessage[]) {
	state.chatSessionId = chatSessionId;
	state.items = items;
}

export function removeQueued(id: string) {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId) return;
	ws.emit('chat:queue-remove', { chatSessionId, id });
}

export function sendQueuedNow(id: string) {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId) return;
	ws.emit('chat:queue-send-now', { chatSessionId, id });
}

/** Pull a queued message back out so it can be changed. */
export async function takeQueued(id: string) {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId) return null;
	return ws.http('chat:queue-take', { chatSessionId, id });
}

/** Call once during app initialization. */
export function setupMessageQueueListener() {
	ws.on('chat:queue', (data) => {
		if (data.chatSessionId !== sessionState.currentSession?.id) return;
		setQueue(data.chatSessionId, data.items);
	});
}

export const messageQueueState = {
	/** Items of the session on screen only — a stale session's queue reads empty. */
	get items(): QueuedMessage[] {
		return state.chatSessionId === sessionState.currentSession?.id ? state.items : [];
	}
};
