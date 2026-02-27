/**
 * WebSocket Type Definitions
 *
 * Shared types for WebSocket communication between backend and frontend
 */

/**
 * WebSocket message format
 */
export interface WSMessage<T = any> {
	action: string;
	payload: T;
}

/**
 * WebSocket client options
 */
export interface WSClientOptions {
	/** Auto-reconnect on connection loss */
	autoReconnect?: boolean;
	/** Maximum reconnection attempts (0 = infinite) */
	maxReconnectAttempts?: number;
	/** Initial reconnect delay in ms */
	reconnectDelay?: number;
	/** Maximum reconnect delay in ms */
	maxReconnectDelay?: number;
	/** Debug logging */
	debug?: boolean;
}

/**
 * WebSocket connection state
 */
export type WSConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * WebSocket error types
 */
export interface WSError {
	type: 'connection' | 'validation' | 'timeout' | 'unknown';
	message: string;
	details?: any;
}
