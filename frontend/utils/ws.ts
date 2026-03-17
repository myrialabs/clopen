/**
 * WebSocket Client Instance
 * Provides a singleton WebSocket client for real-time communication
 * with automatic user/project context synchronization
 */

import { WSClient } from '$shared/utils/ws-client';
import type { WSAPI } from '$backend/ws';
import { setConnectionStatus } from '$frontend/stores/ui/connection.svelte';
import { debug } from '$shared/utils/logger';

/**
 * Get WebSocket URL based on environment
 */
function getWebSocketUrl(): string {
	// Both dev and production: Use current host (Vite proxies /ws to backend in dev)
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const host = window.location.host;
	return `${protocol}//${host}/ws`;
}

// ============================================================================
// Reconnect Handler Registry
// ============================================================================

/** Handlers to run after WebSocket reconnection (re-join rooms, restore subscriptions) */
const reconnectHandlers = new Set<() => void>();

/**
 * Register a handler to run after WebSocket reconnection.
 * Use this to re-join rooms (chat:join-session, projects:join) and
 * restore subscriptions that are lost when the connection drops.
 * Returns an unsubscribe function.
 */
export function onWsReconnect(handler: () => void): () => void {
	reconnectHandlers.add(handler);
	return () => { reconnectHandlers.delete(handler); };
}

// ============================================================================
// WebSocket Client
// ============================================================================

const ws = new WSClient<WSAPI>(getWebSocketUrl(), {
	autoReconnect: true,
	maxReconnectAttempts: 0, // Infinite reconnect
	reconnectDelay: 1000,
	maxReconnectDelay: 30000,
	onStatusChange: (status, reconnectAttempts) => {
		setConnectionStatus(status, reconnectAttempts);
	},
	onReconnect: () => {
		debug.log('websocket', `Running ${reconnectHandlers.size} reconnect handler(s)`);
		for (const handler of reconnectHandlers) {
			try {
				handler();
			} catch (err) {
				debug.error('websocket', 'Reconnect handler error:', err);
			}
		}
	}
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

// Force reload when page is restored from bfcache (back-forward cache).
// After beforeunload, all WS listeners are cleared and the connection is dead.
// A full reload ensures all state (handlers, room subscriptions) is re-initialized.
window.addEventListener('pageshow', (event) => {
	if (event.persisted) {
		window.location.reload();
	}
});

export default ws;
