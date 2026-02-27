/**
 * Preview Services Module
 *
 * Centralized exports for all preview-related services
 */

// Browser-specific services
// Note: Session service removed - operations now in browser-tab-operations.svelte.ts module
export { browserConsoleService } from './browser/browser-console.service';
export type { ConsoleMessage } from './browser/browser-console.service';
export { BrowserWebCodecsService } from './browser/browser-webcodecs.service';

// MCP Preview Integration
export {
	initializeMCPPreview,
	clearMCPPreviewSession,
	clearMCPLaunchRequest,
	getCurrentMCPSession,
	getPendingLaunchRequest,
	isMCPPreviewActive,
	mcpPreviewState
} from './browser/mcp-integration.svelte';
export type { MCPLaunchRequest } from './browser/mcp-integration.svelte';