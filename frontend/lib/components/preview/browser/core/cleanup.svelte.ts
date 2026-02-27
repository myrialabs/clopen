/**
 * Browser Cleanup Handlers
 *
 * Global singleton for handling browser session cleanup on page unload/hide.
 * Tracks active sessions and cleans them up when user leaves the page.
 *
 * IMPORTANT: Sessions are NOT cleaned up on page refresh to support session persistence.
 * Sessions are only cleaned up when:
 * - User navigates away to a different URL
 * - User closes the browser tab/window
 * - Tab is explicitly closed via UI
 */

import ws from '$frontend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

class BrowserCleanupManager {
	private activeSessionIds = new Set<string>();
	private initialized = false;
	private lastHiddenTime?: number;
	// Flag to track if we should preserve sessions (for refresh)
	private preserveSessionsOnUnload = true;

	/**
	 * Initialize cleanup listeners (call once on app startup)
	 */
	initialize(): void {
		if (this.initialized || typeof window === 'undefined') return;
		this.initialized = true;

		// NOTE: We intentionally do NOT cleanup on beforeunload/unload
		// This allows sessions to persist across page refresh
		// Sessions will be recovered on page load via reconnection logic

		// Handle page visibility changes (for tracking purposes only)
		document.addEventListener('visibilitychange', this.handleVisibilityChange);

		debug.log('preview', '🧹 Cleanup manager initialized (sessions preserved on refresh)');
	}

	/**
	 * Register a session for cleanup tracking
	 */
	registerSession(sessionId: string): void {
		this.activeSessionIds.add(sessionId);
		debug.log('preview', `📝 Registered session: ${sessionId} (total: ${this.activeSessionIds.size})`);
	}

	/**
	 * Unregister a session from cleanup tracking
	 */
	unregisterSession(sessionId: string): void {
		this.activeSessionIds.delete(sessionId);
		debug.log('preview', `📝 Unregistered session: ${sessionId} (remaining: ${this.activeSessionIds.size})`);
	}

	/**
	 * Get all active session IDs
	 */
	getActiveSessions(): string[] {
		return Array.from(this.activeSessionIds);
	}

	/**
	 * Clear all tracked sessions (without destroying them)
	 */
	clearAll(): void {
		this.activeSessionIds.clear();
	}

	/**
	 * Check if we should preserve sessions on unload (e.g., refresh)
	 */
	shouldPreserveSessions(): boolean {
		return this.preserveSessionsOnUnload;
	}

	/**
	 * Set whether to preserve sessions on unload
	 * Call with false before intentional navigation away
	 */
	setPreserveSessions(preserve: boolean): void {
		this.preserveSessionsOnUnload = preserve;
	}

	// Event Handlers

	private handleVisibilityChange = () => {
		if (document.hidden && this.activeSessionIds.size > 0) {
			this.lastHiddenTime = Date.now();
			debug.log('preview', `👁️ Page hidden with ${this.activeSessionIds.size} active sessions`);
		} else if (!document.hidden && this.lastHiddenTime) {
			const hiddenDuration = Date.now() - this.lastHiddenTime;
			if (hiddenDuration > 5 * 60 * 1000) {
				// Page was hidden for more than 5 minutes
				debug.log('preview', `⚠️ Page was hidden for ${Math.round(hiddenDuration / 1000)}s, sessions may need reconnection`);
			}
			delete this.lastHiddenTime;
		}
	};

	// Cleanup Utilities - Only called when explicitly closing a tab

	/**
	 * Explicitly close a specific tab (called from UI)
	 */
	async closeTab(tabId: string, projectId: string): Promise<void> {
		if (!projectId) {
			debug.error('preview', '❌ closeTab: No projectId provided');
			return;
		}

		try {
			await ws.http('preview:browser-tab-close', { tabId });
			this.activeSessionIds.delete(tabId);
			debug.log('preview', `🗑️ Explicitly closed tab: ${tabId} (project: ${projectId})`);
		} catch (err) {
			debug.error('preview', 'Error closing tab:', err);
		}
	}

	/**
	 * Explicitly close all tabs (called from UI or component cleanup)
	 */
	async closeAllTabs(projectId: string): Promise<void> {
		if (!projectId) {
			debug.error('preview', '❌ closeAllTabs: No projectId provided');
			return;
		}

		if (this.activeSessionIds.size === 0) return;

		debug.log('preview', `🗑️ Explicitly closing ${this.activeSessionIds.size} tabs (project: ${projectId})`);

		const closePromises = Array.from(this.activeSessionIds).map((tabId) => {
			return ws.http('preview:browser-tab-close', { tabId }).catch((err) => {
				debug.error('preview', `Error closing tab ${tabId}:`, err);
			});
		});

		try {
			await Promise.race([
				Promise.all(closePromises),
				new Promise((resolve) => setTimeout(resolve, 5000))
			]);
		} catch (err) {
			debug.error('preview', 'Tab close timeout:', err);
		}

		this.activeSessionIds.clear();
	}
}

// Export singleton instance
export const browserCleanup = new BrowserCleanupManager();
