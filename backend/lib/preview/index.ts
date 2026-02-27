// Export all browser types (includes StreamingConfig and DEFAULT_STREAMING_CONFIG)
export * from './browser/types';

// Export MCP control types
export type { McpControlState, McpControlEvent, McpCursorEvent, McpClickEvent } from './browser/browser-mcp-control';

// Export the main preview service class and manager
export {
	BrowserPreviewService,
	browserPreviewServiceManager
} from './browser/browser-preview-service.js';

// Export browser-specific handlers
export { BrowserTabManager } from './browser/browser-tab-manager.js';
export { BrowserConsoleManager } from './browser/browser-console-manager.js';
export { BrowserInteractionHandler } from './browser/browser-interaction-handler.js';
export { BrowserNavigationTracker } from './browser/browser-navigation-tracker.js';
export { BrowserAudioCapture } from './browser/browser-audio-capture.js';
export { BrowserVideoCapture } from './browser/browser-video-capture.js';
export { BrowserMcpControl, browserMcpControl } from './browser/browser-mcp-control.js';
export { browserPool } from './browser/browser-pool';

// Note: MCP control initialization is now handled per-project
// Each project's BrowserPreviewService instance should initialize MCP control separately