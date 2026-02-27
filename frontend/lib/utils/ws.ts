/**
 * WebSocket Client Instance
 * Provides a singleton WebSocket client for real-time communication
 * with automatic user/project context synchronization
 */

import { WSClient } from '$shared/utils/ws-client';
import type { WSAPI } from '$backend/ws';

/**
 * Get WebSocket URL based on environment
 */
function getWebSocketUrl(): string {
	// Both dev and production: Use current host (Vite proxies /ws to backend in dev)
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const host = window.location.host;
	return `${protocol}//${host}/ws`;
}

const ws = new WSClient<WSAPI>(getWebSocketUrl(), {
	autoReconnect: true,
	maxReconnectAttempts: 0, // Infinite reconnect
	reconnectDelay: 1000,
	maxReconnectDelay: 30000
});

// CRITICAL: Handle Vite HMR to prevent WebSocket connection accumulation
// Without this, each HMR update creates a new WSClient+connection without
// closing the old one, causing duplicate connections on the server
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		ws.disconnect();
	});
}

// Close WebSocket cleanly on page unload (refresh, tab close, navigate away).
// Without this, the browser may keep the old connection's HTTP upgrade request
// as "pending" during the page transition, causing the loading indicator to
// spin indefinitely after a refresh.
window.addEventListener('beforeunload', () => {
	ws.disconnect();
});

export default ws;
