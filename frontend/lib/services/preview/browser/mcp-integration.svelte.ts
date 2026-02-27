/**
 * MCP Preview Integration Service
 *
 * Handles browser session creation from MCP tools and automatically
 * opens the preview panel to display the session visually.
 */

import ws from '$frontend/lib/utils/ws';
import { showPanel } from '$frontend/lib/stores/ui/workspace.svelte';
import { debug } from '$shared/utils/logger';

export interface MCPLaunchRequest {
	url: string;
	deviceSize: 'desktop' | 'laptop' | 'tablet' | 'mobile';
	rotation: 'portrait' | 'landscape';
}

/**
 * Global state for MCP launch requests
 */
export const mcpPreviewState = $state<{
	pendingLaunch: MCPLaunchRequest | null;
	isActive: boolean;
}>({
	pendingLaunch: null,
	isActive: false
});

/**
 * Initialize MCP preview integration
 * Listens for browser launch requests from MCP tools
 */
export function initializeMCPPreview() {
	debug.log('mcp', '🎬 Initializing MCP Preview Integration');

	// Note: MCP launch event listener removed in the new architecture
	// MCP interactions now use HTTP request-response pattern
	// defined in backend/ws/preview/browser/mcp.ts

	debug.log('mcp', '✓ MCP Preview Integration initialized');
}

/**
 * Clear pending launch request
 */
export function clearMCPLaunchRequest() {
	mcpPreviewState.pendingLaunch = null;
	mcpPreviewState.isActive = false;
}

/**
 * Get pending launch request
 */
export function getPendingLaunchRequest(): MCPLaunchRequest | null {
	return mcpPreviewState.pendingLaunch;
}

/**
 * Check if MCP preview is active
 */
export function isMCPPreviewActive(): boolean {
	return mcpPreviewState.isActive;
}

// Legacy exports for compatibility
export const clearMCPPreviewSession = clearMCPLaunchRequest;
export const getCurrentMCPSession = getPendingLaunchRequest;
