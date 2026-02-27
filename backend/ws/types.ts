/**
 * WebSocket Type Exports
 *
 * Re-exports all WebSocket-related types for easy import across the application.
 */

// Main API type from router
export type { WSAPI } from './index';

// Shared types from shared folder
export type {
	WSMessage,
	WSClientOptions,
	WSConnectionState,
	WSError
} from '$shared/types/websocket';

// Router utilities (for future module development)
export { createRouter } from '$shared/utils/ws-server';
export { WSClient } from '$shared/utils/ws-client';
